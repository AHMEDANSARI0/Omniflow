import fs from 'fs';
import os from 'os';
import path from 'path';
import { neonEnabled, neonQuery, from } from '../../lib/db/neon';
import { loadSiteStats } from '../../lib/omniflow/site-analytics';
import {
  getAdminAiOverview,
  getAdminModelRouter,
  getAdminProviders,
  listAdminUsers,
} from '../../lib/omniflow/admin-control-plane';
import { aiRates, leadStats, type DashboardLead } from '../../lib/omniflow/admin-dashboard';
import { listAllWorkspacesAndUsers } from './workspace-store';
import type { AnalyticsData, BotStats, ChartPoint, PortalStats, WebsiteStats } from './real-data.types';

const CACHE_TTL_MS = 60 * 1000;
const TMP_FILE = path.join(os.tmpdir(), 'omniflow-live-analytics.json');

declare global {
  var __omniflowAnalyticsCache: { data: AnalyticsData; expiresAt: number } | undefined;
}

export function saveAnalyticsData(data: AnalyticsData): void {
  globalThis.__omniflowAnalyticsCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Serverless read-only fallback handled by memory cache
  }
}

export function getLatestAnalytics(): AnalyticsData | null {
  const mem = globalThis.__omniflowAnalyticsCache;
  if (mem && mem.expiresAt > Date.now()) return mem.data;
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8')) as AnalyticsData;
      if (parsed && parsed.website && parsed.portal && parsed.bot) return parsed;
    }
  } catch {
    // ignore
  }
  return mem?.data ?? null;
}

async function queryNeonSiteEvents(): Promise<{ connected: boolean; stats: WebsiteStats }> {
  const emptyTrend: ChartPoint[] = [{ name: 'Today', value: 0, secondary: 0 }];
  const fallback: WebsiteStats = {
    activeVisitors: 0,
    pageViews24h: 0,
    topPages: [],
    trafficSources: [],
    countries: [],
    avgTimeOnSite: 0,
    bounceRate: 0,
    ctaClicks: 0,
    formSubmits: 0,
    dailyTrend: emptyTrend,
  };
  if (!neonEnabled()) return { connected: false, stats: fallback };
  try {
    await neonQuery(
      "CREATE TABLE IF NOT EXISTS site_events (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), event TEXT NOT NULL, path TEXT NOT NULL DEFAULT '/', ref_host TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '', utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT 'desktop', browser TEXT NOT NULL DEFAULT 'other', country TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '', seconds INT NOT NULL DEFAULT 0, visitor TEXT NOT NULL)"
    );
    const [summaryRes, pagesRes, sourcesRes, countriesRes, dailyRes] = await Promise.all([
      neonQuery<{ active: number; views24: number; cta: number; forms: number; avg_sec: number }>(
        "SELECT COUNT(DISTINCT visitor) FILTER (WHERE created_at >= NOW() - INTERVAL '30 minutes') AS active, COUNT(*) FILTER (WHERE event = 'page_view' AND created_at >= NOW() - INTERVAL '24 hours') AS views24, COUNT(*) FILTER (WHERE event = 'cta_click' AND created_at >= NOW() - INTERVAL '30 days') AS cta, COUNT(*) FILTER (WHERE event = 'form_submit' AND created_at >= NOW() - INTERVAL '30 days') AS forms, COALESCE(ROUND(AVG(seconds) FILTER (WHERE event = 'page_time' AND seconds > 0))::INT, 0) AS avg_sec FROM site_events"
      ),
      neonQuery<{ path: string; views: number; visitors: number }>(
        "SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_events WHERE event = 'page_view' AND created_at >= NOW() - INTERVAL '30 days' GROUP BY path ORDER BY views DESC LIMIT 6"
      ),
      neonQuery<{ source: string; count: number }>(
        "SELECT COALESCE(NULLIF(ref_host, ''), 'Direct') AS source, COUNT(*) AS count FROM site_events WHERE event = 'page_view' AND created_at >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY count DESC LIMIT 6"
      ),
      neonQuery<{ country: string; count: number }>(
        "SELECT COALESCE(NULLIF(country, ''), 'Unknown') AS country, COUNT(DISTINCT visitor) AS count FROM site_events WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY count DESC LIMIT 6"
      ),
      neonQuery<{ day: string; views: number; visitors: number }>(
        "SELECT TO_CHAR((created_at AT TIME ZONE 'Asia/Karachi')::date, 'Mon DD') AS day, COUNT(*) FILTER (WHERE event = 'page_view') AS views, COUNT(DISTINCT visitor) AS visitors FROM site_events WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY (created_at AT TIME ZONE 'Asia/Karachi')::date ORDER BY (created_at AT TIME ZONE 'Asia/Karachi')::date ASC"
      ),
    ]);
    const s = summaryRes.rows[0];
    return {
      connected: true,
      stats: {
        activeVisitors: Number(s?.active ?? 0),
        pageViews24h: Number(s?.views24 ?? 0),
        topPages: pagesRes.rows.map((r) => ({ path: String(r.path || '/'), views: Number(r.views ?? 0), visitors: Number(r.visitors ?? 0) })),
        trafficSources: sourcesRes.rows.map((r) => ({ source: String(r.source || 'Direct'), count: Number(r.count ?? 0) })),
        countries: countriesRes.rows.map((r) => ({ country: String(r.country || 'Unknown'), count: Number(r.count ?? 0) })),
        avgTimeOnSite: Number(s?.avg_sec ?? 0),
        bounceRate: 0,
        ctaClicks: Number(s?.cta ?? 0),
        formSubmits: Number(s?.forms ?? 0),
        dailyTrend: dailyRes.rows.length > 0 ? dailyRes.rows.map((r) => ({ name: String(r.day), value: Number(r.views ?? 0), secondary: Number(r.visitors ?? 0) })) : emptyTrend,
      },
    };
  } catch {
    return { connected: false, stats: fallback };
  }
}

async function collectRealWebsiteStats(): Promise<{ connected: boolean; stats: WebsiteStats }> {
  const [cpToday, cpMonth] = await Promise.all([loadSiteStats(1), loadSiteStats(30)]);
  if (cpMonth) {
    const views = cpMonth.totals.views;
    const visitors = cpMonth.totals.visitors;
    const engaged = Math.max(cpMonth.totals.ctaVisitors, cpMonth.totals.formVisitors);
    const bounceRate = visitors > 0 ? Math.max(0, Math.min(100, Math.round(((visitors - engaged) / visitors) * 100))) : 0;
    const dailyTrend: ChartPoint[] = cpMonth.daily.length > 0
      ? cpMonth.daily.slice(-7).map((d) => ({ name: d.day.slice(5), value: d.views, secondary: d.visitors }))
      : [{ name: 'Today', value: cpToday?.totals.views ?? views, secondary: cpToday?.totals.visitors ?? visitors }];
    return {
      connected: true,
      stats: {
        activeVisitors: cpToday?.totals.visitors ?? visitors,
        pageViews24h: cpToday?.totals.views ?? views,
        topPages: cpMonth.pages.map((p) => ({ path: p.path, views: p.views, visitors: p.visitors })),
        trafficSources: cpMonth.sources.map((s) => ({ source: s.source === 'direct' ? 'Direct' : s.source, count: s.views, visitors: s.visitors })),
        countries: cpMonth.countries.map((c) => ({ country: c.country, count: c.visitors })),
        avgTimeOnSite: cpMonth.totals.avgSeconds,
        bounceRate,
        ctaClicks: cpMonth.totals.ctaClicks,
        formSubmits: cpMonth.totals.formSubmits,
        dailyTrend,
      },
    };
  }
  return queryNeonSiteEvents();
}

export async function collectRealAnalytics(forceRefresh = false): Promise<AnalyticsData> {
  if (!forceRefresh) {
    const cached = getLatestAnalytics();
    if (cached) return cached;
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const [webRes, leadsRes, aiRes, usersRes, routerRes, provRes] = await Promise.allSettled([
    collectRealWebsiteStats(),
    from<DashboardLead[]>('leads').select('status, created_at'),
    getAdminAiOverview(30),
    listAllWorkspacesAndUsers(),
    getAdminModelRouter(7),
    getAdminProviders(),
  ]);

  const web = webRes.status === 'fulfilled' ? webRes.value : { connected: false, stats: { activeVisitors: 0, pageViews24h: 0, topPages: [], trafficSources: [], countries: [], avgTimeOnSite: 0, bounceRate: 0, ctaClicks: 0, formSubmits: 0, dailyTrend: [] } };
  const dbLeads = leadsRes.status === 'fulfilled' && Array.isArray(leadsRes.value.data) ? leadsRes.value.data : [];
  const dbOk = leadsRes.status === 'fulfilled' && leadsRes.value.error === null;
  const lStats = leadStats(dbLeads, now, 30);
  const ai = aiRes.status === 'fulfilled' ? aiRes.value : null;
  const users = usersRes.status === 'fulfilled' ? usersRes.value : null;
  const router = routerRes.status === 'fulfilled' ? routerRes.value : null;
  const prov = provRes.status === 'fulfilled' ? provRes.value : null;
  const totals = ai?.totals ?? null;
  const rates = totals ? aiRates(totals) : null;

  let avgLatencySec = 0;
  if (router && Array.isArray(router.usage?.models)) {
    const activeModels = router.usage.models.filter((m) => m.calls > 0 && m.avg_latency_ms > 0);
    const sumCalls = activeModels.reduce((a, m) => a + m.calls, 0);
    const sumMs = activeModels.reduce((a, m) => a + m.avg_latency_ms * m.calls, 0);
    if (sumCalls > 0) avgLatencySec = Math.round((sumMs / sumCalls) / 100) / 10;
  }

  const provChannels = prov?.groups
    ? ['whatsapp_e2e', 'email', 'voice', 'video', 'llm'].filter((g) => prov.groups[g]?.configured === true).length
    : 0;
  const wsConnectedChannels = users
    ? users.reduce((acc, u) => acc + (Array.isArray(u.connected_channels) ? u.connected_channels.length : 0), 0)
    : 0;
  const channelsActive = Math.max(provChannels, wsConnectedChannels);

  const progressed = lStats.byStatus.closed + lStats.byStatus.contacted;
  const leadConversionRate = lStats.total > 0 ? Math.round((progressed / lStats.total) * 1000) / 10 : 0;
  const automationPct = rates?.automationRate !== null && rates?.automationRate !== undefined
    ? Math.round(rates.automationRate * 1000) / 10
    : 0;

  const portal: PortalStats = {
    activeClients: ai?.workspaces ? ai.workspaces.filter((w) => w.calls > 0 || w.agents_active > 0 || w.autonomy !== 'off').length : (users ? users.filter((u) => !u.locked).length : 0),
    totalClients: totals?.workspaces ?? (users ? users.length : 0),
    recentLeads: lStats.recent,
    totalLeads: lStats.total,
    leadConversionRate,
    messagesToday: totals ? totals.answers + totals.handoffs : 0,
    avgResponseTime: avgLatencySec,
    satisfactionScore: automationPct,
    leadsByStatus: { new: lStats.byStatus.new, contacted: lStats.byStatus.contacted, closed: lStats.byStatus.closed },
  };

  const bot: BotStats = {
    activeBots: totals?.agents_active ?? 0,
    totalConversations: totals?.calls ?? 0,
    avgResponseTime: avgLatencySec,
    successRate: automationPct,
    channelsActive,
    unanswered: totals ? totals.open_escalations + totals.pending_approvals : 0,
    answeredByAi: totals?.answers ?? 0,
    handoffs: totals?.handoffs ?? 0,
    failedCalls: totals?.failed ?? 0,
  };

  const result: AnalyticsData = {
    website: web.stats,
    portal,
    bot,
    timestamp: nowIso,
    lastUpdated: nowIso,
    cachedUntil: new Date(now + CACHE_TTL_MS).toISOString(),
    source: 'real',
    sourcesConnected: { database: dbOk || neonEnabled(), controlPlane: ai !== null, siteAnalytics: web.connected },
  };
  saveAnalyticsData(result);
  return result;
}

export function getAnalyticsWithFallback(): AnalyticsData {
  const latest = getLatestAnalytics();
  if (latest) return latest;
  const nowIso = new Date().toISOString();
  return {
    website: { activeVisitors: 0, pageViews24h: 0, topPages: [], trafficSources: [], countries: [], avgTimeOnSite: 0, bounceRate: 0, ctaClicks: 0, formSubmits: 0, dailyTrend: [] },
    portal: { activeClients: 0, totalClients: 0, recentLeads: 0, totalLeads: 0, leadConversionRate: 0, messagesToday: 0, avgResponseTime: 0, satisfactionScore: 0, leadsByStatus: { new: 0, contacted: 0, closed: 0 } },
    bot: { activeBots: 0, totalConversations: 0, avgResponseTime: 0, successRate: 0, channelsActive: 0, unanswered: 0, answeredByAi: 0, handoffs: 0, failedCalls: 0 },
    timestamp: nowIso,
    lastUpdated: nowIso,
    cachedUntil: nowIso,
    source: 'real',
    sourcesConnected: { database: neonEnabled(), controlPlane: false, siteAnalytics: false },
  };
}
