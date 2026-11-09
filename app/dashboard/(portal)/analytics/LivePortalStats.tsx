'use client';

import { useEffect, useState, useCallback } from 'react';
import type { AnalyticsData } from '../../../lib/real-data.types';

const statCard = 'rounded-xl bg-white border border-line p-4 shadow-card';
const statLabel = 'text-[10px] uppercase tracking-wider text-ink-3';
const statValue = 'mt-1 text-xl font-semibold text-ink';

export default function LivePortalStats() {
  const [stats, setStats] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/omniflow/live/admin-stats', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as AnalyticsData;
        if (data && data.website) setStats(data);
      }
    } catch (e) {
      console.error('Failed to fetch live portal stats:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 60000);
    return () => clearInterval(id);
  }, [fetchStats]);

  if (loading || !stats) {
    return (
      <div className='mb-6 flex items-center justify-center rounded-2xl border border-line bg-white py-6 shadow-card'>
        <div className='h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent' />
        <span className='ml-2.5 text-xs text-ink-3'>Loading live analytics...</span>
      </div>
    );
  }

  return (
    <div className='mb-6 space-y-4'>
      <div className='rounded-2xl border border-brand/20 bg-gradient-to-r from-brand/10 to-emerald-500/10 p-5'>
        <div className='flex flex-wrap items-center justify-between gap-4'>
          <div>
            <p className='text-xs text-ink-3'>Active Visitors (Live)</p>
            <p className='text-2xl font-bold text-ink'>{stats.website.activeVisitors}</p>
          </div>
          <div className='text-right'>
            <p className='text-xs text-ink-3'>Page Views (24h)</p>
            <p className='text-lg font-semibold text-ink'>{stats.website.pageViews24h}</p>
          </div>
        </div>
      </div>
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <div className={statCard}><p className={statLabel}>Avg Time on Site</p><p className={statValue}>{stats.website.avgTimeOnSite}s</p></div>
        <div className={statCard}><p className={statLabel}>Bounce Rate</p><p className={statValue}>{stats.website.bounceRate}%</p></div>
        <div className={statCard}><p className={statLabel}>Active AI Agents</p><p className={statValue}>{stats.bot.activeBots}</p></div>
        <div className={statCard}><p className={statLabel}>AI Automation Rate</p><p className={statValue}>{stats.bot.successRate}%</p></div>
      </div>
    </div>
  );
}
