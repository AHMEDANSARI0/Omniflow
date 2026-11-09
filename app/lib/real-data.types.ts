/**
 * Real Data Types for Live Analytics
 * Replace mock data with actual sources when ready
 */

export interface RealWebsiteStats {
  activeVisitors: number;
  pageViews24h: number;
  topPages: { path: string; views: number }[];
  trafficSources: { source: string; count: number }[];
  countries: { country: string; count: number }[];
  avgTimeOnSite: number;
  bounceRate: number;
}

export interface RealPortalStats {
  activeClients: number;
  totalClients: number;
  recentLeads: number;
  leadConversionRate: number;
  messagesToday: number;
  avgResponseTime: number;
  satisfactionScore: number;
}

export interface RealBotStats {
  activeBots: number;
  totalConversations: number;
  avgResponseTime: number;
  successRate: number;
  channelsActive: number;
  unanswered: number;
}

export interface LiveAnalyticsResponse {
  website: RealWebsiteStats;
  portal: RealPortalStats;
  bot: RealBotStats;
  timestamp: string;
  source: 'mock' | 'database' | 'api';
}

// Mock generators (current)
export function getMockWebsiteStats() {
  return {
    activeVisitors: Math.floor(Math.random() * 25) + 8,
    pageViews24h: Math.floor(Math.random() * 600) + 300,
    topPages: [
      { path: "/", views: 120 },
      { path: "/features", views: 50 },
      { path: "/pricing", views: 45 },
      { path: "/contact", views: 28 },
    ],
    trafficSources: [
      { source: "Direct", count: 85 },
      { source: "Google", count: 62 },
      { source: "Social", count: 38 },
    ],
    countries: [
      { country: "Pakistan", count: 95 },
      { country: "India", count: 45 },
      { country: "USA", count: 28 },
    ],
    avgTimeOnSite: 95,
    bounceRate: 42,
  };
}

export function getMockPortalStats() {
  return {
    activeClients: Math.floor(Math.random() * 15) + 5,
    totalClients: 120,
    recentLeads: 18,
    leadConversionRate: 52.5,
    messagesToday: 425,
    avgResponseTime: 1.8,
    satisfactionScore: 82.5,
  };
}

export function getMockBotStats() {
  return {
    activeBots: 7,
    totalConversations: 4250,
    avgResponseTime: 2.3,
    successRate: 87.2,
    channelsActive: 4,
    unanswered: 5,
  };
}

// Real data functions - implement when ready
// export async function getRealWebsiteStats() { ... }
// export async function getRealPortalStats() { ... }
// export async function getRealBotStats() { ... }
