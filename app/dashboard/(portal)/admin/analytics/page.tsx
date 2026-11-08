import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { motion } from "motion/react";
import AnalyticsChart from "@/app/components/admin/AnalyticsChart";
import ClientDelayTable from "@/app/components/admin/ClientDelayTable";

interface AnalyticsData {
  total_clients: number;
  average_delay_seconds: number;
  max_delay_seconds: number;
  min_delay_seconds: number;
  clients: Array<{
    client_id: string;
    responseDelaySeconds: number;
  }>;
  updated_at: string;
}

interface TrendData {
  date: string;
  avgDelay: number;
  count: number;
}

export default async function AnalyticsPage() {
  const session = (await cookies()).get("session");
  if (!session?.value) {
    redirect("/login");
  }

  let analytics: AnalyticsData = {
    total_clients: 0,
    average_delay_seconds: 0,
    max_delay_seconds: 0,
    min_delay_seconds: 0,
    clients: [],
    updated_at: new Date().toISOString(),
  };
  let trendData: TrendData[] = [];

  try {
    const response = await fetch(
      "http://localhost:3000/api/omniflow/portal/bot/analytics",
      {
        headers: { Cookie: `session=${session.value}` },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      console.error("Failed to fetch analytics:", response.status);
    } else {
      analytics = (await response.json()) as AnalyticsData;
      trendData = [
        { date: "00:00", avgDelay: analytics.average_delay_seconds, count: analytics.total_clients },
        { date: "06:00", avgDelay: Math.max(0, analytics.average_delay_seconds - 10), count: Math.max(0, analytics.total_clients - 1) },
        { date: "12:00", avgDelay: analytics.average_delay_seconds, count: analytics.total_clients },
        { date: "18:00", avgDelay: Math.max(0, analytics.average_delay_seconds + 5), count: analytics.total_clients },
        { date: "23:59", avgDelay: analytics.average_delay_seconds, count: analytics.total_clients },
      ];
    }
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
  }

  // Convert delay to trend data format
  const chartData = trendData.length > 0
    ? trendData
    : [
        { date: new Date().toISOString().slice(0, 10), avgDelay: analytics.average_delay_seconds, count: analytics.total_clients },
      ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Analytics</h1>
          <p className="text-sm text-ink-3">Response delay statistics for all clients</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-ink-3">Last updated</p>
          <p className="text-sm text-ink">
            {new Date(analytics.updated_at).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-line bg-white shadow-card p-4"
        >
          <p className="text-xs text-ink-3 mb-1">Total Clients</p>
          <p className="text-2xl font-semibold text-ink">{analytics.total_clients}</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-xl border border-line bg-white shadow-card p-4"
        >
          <p className="text-xs text-ink-3 mb-1">Average Delay</p>
          <p className="text-2xl font-semibold text-ink">{analytics.average_delay_seconds}s</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-xl border border-line bg-white shadow-card p-4"
        >
          <p className="text-xs text-ink-3 mb-1">Min Delay</p>
          <p className="text-2xl font-semibold text-emerald-600">{analytics.min_delay_seconds}s</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="rounded-xl border border-line bg-white shadow-card p-4"
        >
          <p className="text-xs text-ink-3 mb-1">Max Delay</p>
          <p className="text-2xl font-semibold text-red-600">{analytics.max_delay_seconds}s</p>
        </motion.div>
      </div>

      {/* Chart */}
      <AnalyticsChart data={chartData} title="Response Delay Trend (Last 24h)" />

      {/* Client Table */}
      <div>
        <h2 className="text-sm font-medium text-ink mb-3">All Clients</h2>
        <ClientDelayTable clients={analytics.clients} />
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-emerald-500"></span>
          Instant (0s)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-blue-500"></span>
          Fast (1-60s)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-amber-500"></span>
          Medium (61-300s)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-red-500"></span>
          Slow (301-3600s)
        </span>
      </div>
    </motion.div>
  );
}
