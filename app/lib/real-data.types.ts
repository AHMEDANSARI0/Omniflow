export interface ChartPoint {
  name: string;
  value: number;
  secondary?: number;
  [key: string]: string | number | undefined;
}

export interface WebsiteStats {
  activeVisitors: number;
  pageViews24h: number;
  topPages: { path: string; views: number; visitors?: number }[];
  trafficSources: { source: string; count: number; visitors?: number }[];
  countries: { country: string; count: number }[];
  avgTimeOnSite: number;
  bounceRate: number;
  ctaClicks: number;
  formSubmits: number;
  dailyTrend: ChartPoint[];
}

export interface PortalStats {
  activeClients: number;
  totalClients: number;
  recentLeads: number;
  totalLeads: number;
  leadConversionRate: number;
  messagesToday: number;
  avgResponseTime: number;
  satisfactionScore: number;
  leadsByStatus: { new: number; contacted: number; closed: number };
}

export interface BotStats {
  activeBots: number;
  totalConversations: number;
  avgResponseTime: number;
  successRate: number;
  channelsActive: number;
  unanswered: number;
  answeredByAi: number;
  handoffs: number;
  failedCalls: number;
}

export interface AnalyticsData {
  website: WebsiteStats;
  portal: PortalStats;
  bot: BotStats;
  timestamp: string;
  lastUpdated: string;
  cachedUntil: string;
  source: 'real';
  sourcesConnected: {
    database: boolean;
    controlPlane: boolean;
    siteAnalytics: boolean;
  };
}
