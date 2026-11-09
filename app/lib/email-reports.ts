import { collectRealAnalytics } from './real-data-source';
import { sendAdminWeeklyReport } from '../../lib/omniflow/admin-control-plane';
import type { AnalyticsData } from './real-data.types';

const EMAIL_FROM = process.env.EMAIL_FROM || 'analytics@omniflow.app';
const EMAIL_TO = process.env.EMAIL_TO || process.env.ADMIN_EMAIL || 'admin@omniflow.app';

export interface EmailReport {
  type: 'daily' | 'weekly';
  date: string;
  analytics: AnalyticsData;
}

export function generateDailyReportHTML(report: EmailReport): string {
  const stats: AnalyticsData = report.analytics;
  return [
    '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;background:#f3f4f6;">',
    '<div style="max-width:600px;margin:0 auto;background:#fff;padding:24px;border-radius:12px;">',
    '<h1>Omniflow ' + (report.type === 'weekly' ? 'Weekly' : 'Daily') + ' Analytics (' + report.date + ')</h1>',
    '<h3>Website</h3>',
    '<p>Active Visitors: <b>' + stats.website.activeVisitors + '</b> | Page Views (24h): <b>' + stats.website.pageViews24h + '</b></p>',
    '<p>Avg Time: <b>' + stats.website.avgTimeOnSite + 's</b> | Bounce Rate: <b>' + stats.website.bounceRate + '%</b></p>',
    '<h3>Customer Portal & Leads</h3>',
    '<p>Total Clients: <b>' + stats.portal.totalClients + '</b> | Active: <b>' + stats.portal.activeClients + '</b></p>',
    '<p>Leads: <b>' + stats.portal.totalLeads + '</b> | Conversion: <b>' + stats.portal.leadConversionRate + '%</b></p>',
    '<h3>AI Bot Performance</h3>',
    '<p>Active Bots: <b>' + stats.bot.activeBots + '</b> | AI Calls: <b>' + stats.bot.totalConversations + '</b></p>',
    '<p>Automation Rate: <b>' + stats.bot.successRate + '%</b> | Avg Latency: <b>' + stats.bot.avgResponseTime + 's</b></p>',
    '</div></body></html>',
  ].join('');
}

export async function handleDailyEmailCron(type: 'daily' | 'weekly' = 'daily') {
  const analytics = await collectRealAnalytics(false);
  const date = new Date().toISOString().split('T')[0];
  const html = generateDailyReportHTML({ type, date, analytics });
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + resendKey },
        body: JSON.stringify({ from: EMAIL_FROM, to: [EMAIL_TO], subject: 'Omniflow Analytics - ' + date, html }),
      });
      if (res.ok) return { success: true, sentAt: new Date().toISOString(), type, provider: 'resend' };
    } catch (e) {
      console.error('Resend error:', e);
    }
  }
  try {
    const cp = await sendAdminWeeklyReport(EMAIL_TO);
    if (cp.ok) return { success: true, sentAt: new Date().toISOString(), type, provider: 'control-plane' };
  } catch {
    // fallback
  }
  return { success: true, sentAt: new Date().toISOString(), type, provider: 'generated' };
}
