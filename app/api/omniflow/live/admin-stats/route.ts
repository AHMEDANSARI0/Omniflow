import { NextResponse } from "next/server";

export async function GET() {
  const stats = {
    website: {
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
    },
    portal: {
      activeClients: 12,
      totalClients: 120,
      recentLeads: 18,
      leadConversionRate: 52.5,
      messagesToday: 425,
      avgResponseTime: 1.8,
      satisfactionScore: 82.5,
    },
    bot: {
      activeBots: 7,
      totalConversations: 4250,
      avgResponseTime: 2.3,
      successRate: 87.2,
      channelsActive: 4,
      unanswered: 5,
    },
    lastUpdated: new Date().toISOString(),
  };

  return NextResponse.json(stats, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}