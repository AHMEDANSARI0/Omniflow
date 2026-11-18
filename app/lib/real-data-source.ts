import "server-only";

import { neonEnabled, neonQuery } from "../../lib/db/neon";
import {
  getAdminAiOverview,
  listAdminUsers,
} from "../../lib/omniflow/admin-control-plane";
import { loadSiteStats } from "../../lib/omniflow/site-analytics";
import { createClient } from "../../lib/supabase/server";
import type { AnalyticsData, ChartPoint } from "./real-data.types";

let cachedStats: AnalyticsData | null = null;
let cacheTime = 0;
const CACHE_TTL = 15_000;

export async function fetchRealAnalyticsData(
  forceRefresh = false
): Promise<AnalyticsData> {
  const now = Date.now();
  if (!forceRefresh && cachedStats && now - cacheTime < CACHE_TTL) {
    return cachedStats;
  }

  const [siteStatsRes, aiOverviewRes, usersRes] = await Promise.allSettled([
    loadSiteStats(7),
    getAdminAiOverview(7),
    listAdminUsers(),
  ]);

  const siteStats =
    siteStatsRes.status === "fulfilled" ? siteStatsRes.value : null;
  const aiOverview =
    aiOverviewRes.status === "fulfilled" ? aiOverviewRes.value : null;
  const cpUsers = usersRes.status === "fulfilled" ? usersRes.value : [];

  // 1. Real Leads from Supabase
  let totalLeads = 0;
  let recentLeads = 0;
  let convertedLeads = 0;
  const leadsByStatus = { new: 0, contacted: 0, closed: 0 };
  const leadsByDay = new Map<string, number>();

  try {
    const supabase = await createClient();
    const { data: leadsData } = await supabase
      .from("leads")
      .select("id, status, created_at");
    if (Array.isArray(leadsData)) {
      totalLeads = leadsData.length;
      const sevenDaysAgo = new Date(now - 7 * 86400_000);
      for (const l of leadsData) {
        const createdIso = l.created_at ? String(l.created_at) : "";
        const created = createdIso ? new Date(createdIso) : null;
        if (created && !Number.isNaN(created.getTime())) {
          if (created >= sevenDaysAgo) recentLeads++;
          const dayKey = created.toISOString().slice(0, 10);
          leadsByDay.set(dayKey, (leadsByDay.get(dayKey) || 0) + 1);
        }
        const st = String(l.status || "").toLowerCase();
        if (st === "converted" || st === "closed" || st === "won" || st === "qualified") {
          convertedLeads++;
          leadsByStatus.closed++;
        } else if (st === "contacted" || st === "in_progress") {
          leadsByStatus.contacted++;
        } else {
          leadsByStatus.new++;
        }
      }
    }
  } catch {
    // Supabase leads unavailable
  }

  // 2. Real Website Analytics from Control Plane site-analytics OR Neon site_events
  let activeVisitors = siteStats?.totals.visitors ?? 0;
  let pageViews24h = siteStats?.totals.views ?? 0;
  let avgTimeOnSite = siteStats?.totals.avgSeconds ?? 0;
  let ctaClicks = siteStats?.totals.ctaClicks ?? 0;
  let formSubmits = siteStats?.totals.formSubmits ?? 0;
  let bounceRate = 0;
  let topPages: { path: string; views: number; visitors?: number }[] = (
    siteStats?.pages ?? []
  ).map((p) => ({ path: p.path, views: p.views, visitors: p.visitors }));
  const trafficSources: { source: string; count: number; visitors?: number }[] = (
    siteStats?.sources ?? []
  ).map((s) => ({ source: s.source, count: s.views, visitors: s.visitors }));
  const countries: { country: string; count: number }[] = (
    siteStats?.countries ?? []
  ).map((c) => ({ country: c.country, count: c.visitors }));
  let dailyTrend: ChartPoint[] = (siteStats?.daily ?? []).map((d) => ({
    name: d.day,
    value: d.views,
    secondary: d.visitors,
  }));

  if (!siteStats && neonEnabled()) {
    try {
      const totalsRes = await neonQuery<{
        views: number;
        visitors: number;
        avg_seconds: number;
        cta_clicks: number;
        form_submits: number;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE event = 'page_view')::int AS views,
           COUNT(DISTINCT visitor)::int AS visitors,
           COALESCE(AVG(seconds) FILTER (WHERE event = 'page_time' AND seconds > 0), 0)::int AS avg_seconds,
           COUNT(*) FILTER (WHERE event = 'cta_click')::int AS cta_clicks,
           COUNT(*) FILTER (WHERE event = 'form_submit')::int AS form_submits
         FROM site_events
         WHERE created_at >= NOW() - INTERVAL '24 hours'`
      );
      if (totalsRes.rows[0]) {
        pageViews24h = Number(totalsRes.rows[0].views || 0);
        activeVisitors = Number(totalsRes.rows[0].visitors || 0);
        avgTimeOnSite = Number(totalsRes.rows[0].avg_seconds || 0);
        ctaClicks = Number(totalsRes.rows[0].cta_clicks || 0);
        formSubmits = Number(totalsRes.rows[0].form_submits || 0);
      }

      const pagesRes = await neonQuery<{ path: string; views: number }>(
        `SELECT path, COUNT(*)::int AS views
         FROM site_events
         WHERE event = 'page_view' AND created_at >= NOW() - INTERVAL '7 days'
         GROUP BY path
         ORDER BY views DESC
         LIMIT 5`
      );
      topPages = pagesRes.rows.map((r) => ({
        path: r.path,
        views: Number(r.views || 0),
      }));

      const dailyRes = await neonQuery<{
        day: string;
        views: number;
        visitors: number;
      }>(
        `SELECT TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(*) FILTER (WHERE event = 'page_view')::int AS views,
                COUNT(DISTINCT visitor)::int AS visitors
         FROM site_events
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY 1
         ORDER BY 1 ASC`
      );
      dailyTrend = dailyRes.rows.map((r) => ({
        name: r.day,
        value: Number(r.views || 0),
        secondary: Number(r.visitors || 0),
      }));
    } catch {
      // site_events table not created yet
    }
  }

  if (dailyTrend.length === 0 && leadsByDay.size > 0) {
    dailyTrend = Array.from(leadsByDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({
        name: day,
        value: count,
        secondary: count,
      }));
  }

  if (pageViews24h > 0 && activeVisitors > 0) {
    bounceRate = Math.max(
      0,
      Math.min(100, Math.round((activeVisitors / pageViews24h) * 100))
    );
  }

  // 3. Real Clients, Conversations & Bot metrics from Control Plane + Neon
  let totalUsers = cpUsers.length;
  let activeUsers = cpUsers.filter(
    (u) => !u.locked && (u.status || "active").toLowerCase() === "active"
  ).length;
  let totalConversations = aiOverview?.totals.calls ?? 0;
  const answeredByAi = aiOverview?.totals.answers ?? 0;
  const handoffs = aiOverview?.totals.handoffs ?? 0;
  const failedCalls = aiOverview?.totals.failed ?? 0;
  const unanswered = aiOverview?.totals.open_escalations ?? 0;
  const activeBots = (aiOverview?.workspaces ?? []).reduce(
    (acc, ws) => acc + (ws.agents_active || 0),
    0
  );
  let channelsActive = 0;
  let messagesToday = 0;

  if (neonEnabled()) {
    try {
      if (totalUsers === 0) {
        const uRes = await neonQuery<{ total: number; active: number }>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE COALESCE(LOWER(status), 'active') = 'active')::int AS active
           FROM platform_users`
        );
        if (uRes.rows[0]) {
          totalUsers = Number(uRes.rows[0].total || 0);
          activeUsers = Number(uRes.rows[0].active || 0);
        }
      }

      const convRes = await neonQuery<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM portal_conversations`
      );
      if (convRes.rows[0] && totalConversations === 0) {
        totalConversations = Number(convRes.rows[0].total || 0);
      }

      const msgRes = await neonQuery<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM portal_messages WHERE created_at >= NOW() - INTERVAL '24 hours'`
      ).catch(() => ({ rows: [{ cnt: 0 }] }));
      messagesToday = Number(msgRes.rows[0]?.cnt || 0);

      const waRes = await neonQuery<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM portal_whatsapp_status WHERE state = 'connected'`
      ).catch(() => ({ rows: [{ cnt: 0 }] }));
      const igRes = await neonQuery<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM portal_instagram_accounts WHERE enabled = TRUE`
      ).catch(() => ({ rows: [{ cnt: 0 }] }));
      const socRes = await neonQuery<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM portal_social_accounts WHERE connected = TRUE`
      ).catch(() => ({ rows: [{ cnt: 0 }] }));

      channelsActive =
        Number(waRes.rows[0]?.cnt || 0) +
        Number(igRes.rows[0]?.cnt || 0) +
        Number(socRes.rows[0]?.cnt || 0);
    } catch {
      // ignore
    }
  }

  const conversionRateNum =
    totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;
  const aiSuccessRate =
    totalConversations > 0
      ? Math.min(100, Math.round((answeredByAi / totalConversations) * 100))
      : 0;
  const nowIso = new Date(now).toISOString();

  const result: AnalyticsData = {
    website: {
      activeVisitors,
      pageViews24h,
      avgTimeOnSite,
      bounceRate,
      ctaClicks,
      formSubmits,
      topPages,
      trafficSources,
      countries,
      dailyTrend,
    },
    portal: {
      totalClients: totalUsers,
      activeClients: activeUsers,
      totalLeads,
      recentLeads,
      leadConversionRate: conversionRateNum,
      messagesToday,
      avgResponseTime: 0,
      satisfactionScore: aiSuccessRate,
      leadsByStatus,
    },
    bot: {
      activeBots,
      totalConversations,
      answeredByAi,
      unanswered,
      handoffs,
      failedCalls,
      avgResponseTime: 0,
      successRate: aiSuccessRate,
      channelsActive,
    },
    timestamp: nowIso,
    lastUpdated: nowIso,
    cachedUntil: new Date(now + CACHE_TTL).toISOString(),
    source: "real",
    sourcesConnected: {
      database: neonEnabled(),
      controlPlane: Boolean(aiOverview || cpUsers.length > 0),
      siteAnalytics: Boolean(siteStats),
    },
  };

  cachedStats = result;
  cacheTime = now;
  return result;
}

export const collectRealAnalytics = fetchRealAnalyticsData;
