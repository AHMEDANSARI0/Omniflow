"use client";

import { useEffect, useState, useCallback } from "react";

interface LiveWebsiteStats {
  activeVisitors: number;
  pageViews24h: number;
  topPages: { path: string; views: number }[];
  trafficSources: { source: string; count: number }[];
  countries: { country: string; count: number }[];
  avgTimeOnSite: number;
  bounceRate: number;
}

interface LiveBotStats {
  activeBots: number;
  totalConversations: number;
  avgResponseTime: number;
  successRate: number;
  channelsActive: number;
}

interface LiveStatsResponse {
  website: LiveWebsiteStats;
  bot: LiveBotStats;
  timestamp: string;
}

const statCard = "rounded-xl bg-white border border-line p-4 shadow-card";
const statLabel = "text-[10px] uppercase tracking-wider text-ink-3";
const statValue = "mt-1 text-xl font-semibold text-ink";

export default function LivePortalStats() {
  const [stats, setStats] = useState<LiveStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/cron/live-analytics", {
        method: "GET",
        headers: { "Cache-Control": "no-cache" },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.stats) {
          setStats(data.stats);
        }
      }
    } catch (error) {
      console.error("Failed to fetch live stats:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 60000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  if (loading || !stats) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-r from-brand/10 to-emerald-500/10 border border-brand/20 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-brand/20 animate-ping" />
              <div className="relative h-10 w-10 rounded-full bg-brand/10 flex items-center justify-center">
                <svg className="h-5 w-5 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
            <div>
              <p className="text-xs text-ink-3">Currently Online</p>
              <p className="text-2xl font-bold text-ink">{stats.website.activeVisitors}</p>
              <p className="text-[10px] text-ink-3">active visitors on website</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-ink-3">Today's Page Views</p>
            <p className="text-lg font-semibold text-ink">{stats.website.pageViews24h}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className={statCard}>
          <p className={statLabel}>Avg Time on Site</p>
          <p className={statValue}>{stats.website.avgTimeOnSite}s</p>
          <p className="text-[10px] text-ink-3 mt-1">Average session duration</p>
        </div>
        <div className={statCard}>
          <p className={statLabel}>Bounce Rate</p>
          <p className={statValue}>{stats.website.bounceRate}%</p>
          <p className="text-[10px] text-ink-3 mt-1">Single page visits</p>
        </div>
        <div className={statCard}>
          <p className={statLabel}>Active Bots</p>
          <p className={statValue}>{stats.bot.activeBots}</p>
          <p className="text-[10px] text-ink-3 mt-1">WhatsApp bots running</p>
        </div>
        <div className={statCard}>
          <p className={statLabel}>Success Rate</p>
          <p className={statValue}>{stats.bot.successRate}%</p>
          <p className="text-[10px] text-ink-3 mt-1">Auto-resolved conversations</p>
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-line p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink mb-4">Traffic Sources</h3>
        <div className="space-y-3">
          {stats.website.trafficSources.map((source, index) => {
            const total = stats.website.trafficSources.reduce((a, b) => a + b.count, 0) || 1;
            const percent = Math.round((source.count / total) * 100);
            return (
              <div key={index} className="flex items-center gap-3">
                <span className="text-xs text-ink-2 w-32 truncate">{source.source}</span>
                <div className="flex-1 h-2 bg-soft rounded-full overflow-hidden">
                  <div className="h-full bg-brand/60 rounded-full transition-all duration-500" style={{ width: `${percent}%` }} />
                </div>
                <span className="text-xs text-ink-3 w-16 text-right">{source.count}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-line p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink mb-4">Top Pages</h3>
        <div className="space-y-2">
          {stats.website.topPages.map((page, index) => (
            <div key={index} className="flex items-center justify-between py-2 border-b border-line last:border-0">
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-ink-3 w-6">#{index + 1}</span>
                <span className="text-sm text-ink truncate max-w-[200px]">{page.path}</span>
              </div>
              <span className="text-sm font-medium text-ink">{page.views} views</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}