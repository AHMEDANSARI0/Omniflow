'use client';

import { useEffect, useState, useCallback } from 'react';
import AnalyticsChart from '../../../components/admin/AnalyticsChart';
import type { AnalyticsData } from '../../../lib/real-data.types';

const statCardClass = 'rounded-2xl border border-line bg-white shadow-card px-5 py-4';
const statLabelClass = 'text-[10px] uppercase tracking-wider text-ink-3';
const statValueClass = 'mt-1 text-lg font-semibold text-ink';
const sectionClass = 'rounded-2xl border border-line bg-white shadow-card p-6';

export default function AdminAnalyticsPage() {
  const [stats, setStats] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);

  const loadStats = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/omniflow/live/admin-stats', {
        method: force ? 'POST' : 'GET',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load analytics');
      const data = await res.json();
      setStats(data.stats ? data.stats : data);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats(false);
    const id = setInterval(() => loadStats(false), 30000);
    return () => clearInterval(id);
  }, [loadStats]);

  const sendEmailReport = async (type: 'daily' | 'weekly') => {
    setSendingEmail(true);
    setEmailStatus(null);
    try {
      const res = await fetch('/api/omniflow/cron/daily-email?type=' + type, { method: 'POST' });
      const payload = await res.json();
      setEmailStatus(res.ok && payload.success ? (type === 'weekly' ? 'Weekly' : 'Daily') + ' report sent (' + payload.provider + ').' : 'Failed to send report.');
    } catch {
      setEmailStatus('Error sending email report.');
    } finally {
      setSendingEmail(false);
    }
  };

  if (loading && !stats) {
    return <div className='min-h-screen bg-bg p-6 text-sm text-ink-3'>Loading real-time analytics...</div>;
  }
  if (error && !stats) {
    return <div className='min-h-screen bg-bg p-6 text-sm text-danger'>{error}</div>;
  }

  const trendData = stats?.website.dailyTrend && stats.website.dailyTrend.length > 0
    ? stats.website.dailyTrend
    : [{ name: 'Today', value: stats?.website.pageViews24h ?? 0, secondary: stats?.website.activeVisitors ?? 0 }];

  const barData = [
    { name: 'Views', value: stats?.website.pageViews24h ?? 0 },
    { name: 'Leads', value: stats?.portal.totalLeads ?? 0 },
    { name: 'AI Replies', value: stats?.bot.answeredByAi ?? 0 },
    { name: 'AI Calls', value: stats?.bot.totalConversations ?? 0 },
    { name: 'Clients', value: stats?.portal.totalClients ?? 0 },
  ];

  return (
    <div className='min-h-screen bg-bg p-6'>
      <div className='mb-6 flex flex-wrap items-center justify-between gap-4'>
        <div>
          <h1 className='text-xl font-semibold text-ink'>Live Analytics (Real Data)</h1>
          <p className='mt-1 text-sm text-ink-3'>Database & Control Plane metrics</p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-xs text-ink-3'>Updated: {lastRefresh ? lastRefresh.toLocaleTimeString() : '—'}</span>
          <button onClick={() => sendEmailReport('daily')} disabled={sendingEmail} className='rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:text-ink'>Email Daily Report</button>
          <button onClick={() => sendEmailReport('weekly')} disabled={sendingEmail} className='rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:text-ink'>Email Weekly Report</button>
          <button onClick={() => loadStats(true)} disabled={loading} className='rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white'>{loading ? 'Refreshing...' : 'Refresh'}</button>
        </div>
      </div>

      {emailStatus && <div className='mb-4 rounded-xl border border-brand/20 bg-brand/5 px-4 py-2.5 text-xs text-ink'>{emailStatus}</div>}

      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <div className={statCardClass}><p className={statLabelClass}>Active Visitors</p><p className={statValueClass}>{stats?.website.activeVisitors ?? 0}</p><p className='mt-1 text-xs text-ink-3'>{stats?.website.pageViews24h ?? 0} views (24h)</p></div>
        <div className={statCardClass}><p className={statLabelClass}>Total Clients</p><p className={statValueClass}>{stats?.portal.totalClients ?? 0}</p><p className='mt-1 text-xs text-ink-3'>{stats?.portal.activeClients ?? 0} active</p></div>
        <div className={statCardClass}><p className={statLabelClass}>AI Calls</p><p className={statValueClass}>{(stats?.bot.totalConversations ?? 0).toLocaleString()}</p><p className='mt-1 text-xs text-ink-3'>{stats?.bot.successRate ?? 0}% automated</p></div>
        <div className={statCardClass}><p className={statLabelClass}>Lead Conversion</p><p className={statValueClass}>{stats?.portal.leadConversionRate ?? 0}%</p><p className='mt-1 text-xs text-ink-3'>{stats?.portal.recentLeads ?? 0} recent leads</p></div>
      </div>

      <div className='mt-6 grid gap-6 lg:grid-cols-2'>
        <AnalyticsChart data={trendData} title='Website Traffic Trend' subtitle='Daily views & visitors' variant='line' color='#2563eb' />
        <AnalyticsChart data={barData} title='Platform Activity Overview' subtitle='Views, Leads, AI Replies, Calls & Clients' variant='bar' color='#7c3aed' />
      </div>

      <div className='mt-6 grid gap-6 lg:grid-cols-2'>
        <section className={sectionClass}>
          <h2 className='mb-4 text-sm font-semibold text-ink'>Website Analytics</h2>
          <div className='grid grid-cols-2 gap-4'>
            <div className='rounded-xl bg-soft p-3'><p className={statLabelClass}>Avg Time</p><p className='mt-1 font-semibold text-ink'>{stats?.website.avgTimeOnSite ?? 0}s</p></div>
            <div className='rounded-xl bg-soft p-3'><p className={statLabelClass}>Bounce Rate</p><p className='mt-1 font-semibold text-ink'>{stats?.website.bounceRate ?? 0}%</p></div>
          </div>
          <div className='mt-4 space-y-2'>
            <h3 className='text-xs font-semibold text-ink-3'>Top Pages</h3>
            {(stats?.website.topPages ?? []).map((p, i) => (
              <div key={i} className='flex justify-between text-xs'><span className='text-ink-2'>{p.path}</span><span className='font-medium text-ink'>{p.views}</span></div>
            ))}
          </div>
        </section>
        <section className={sectionClass}>
          <h2 className='mb-4 text-sm font-semibold text-ink'>Customer Portal & Bot</h2>
          <div className='grid grid-cols-2 gap-4'>
            <div className='rounded-xl bg-soft p-3'><p className={statLabelClass}>Active Bots</p><p className='mt-1 font-semibold text-ink'>{stats?.bot.activeBots ?? 0}</p></div>
            <div className='rounded-xl bg-soft p-3'><p className={statLabelClass}>Channels Active</p><p className='mt-1 font-semibold text-ink'>{stats?.bot.channelsActive ?? 0}</p></div>
            <div className='rounded-xl bg-soft p-3'><p className={statLabelClass}>Avg Latency</p><p className='mt-1 font-semibold text-ink'>{stats?.bot.avgResponseTime ?? 0}s</p></div>
            <div className='rounded-xl bg-soft p-3'><p className={statLabelClass}>Open Escalations</p><p className='mt-1 font-semibold text-ink'>{stats?.bot.unanswered ?? 0}</p></div>
          </div>
        </section>
      </div>
    </div>
  );
}
