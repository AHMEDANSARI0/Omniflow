import { GetServerSideProps } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { motion } from "motion/react";
import React, { useState } from "react";

interface MonitoringData {
  uptime: string;
  memory_usage: string;
  cpu_usage: string;
  requests_per_minute: number;
  error_rate: number;
  active_connections: number;
  last_error: string | null;
  last_updated: string;
}

interface ErrorLog {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  source: string;
  client_id: string;
  details: Record<string, unknown>;
}

interface PageProps {
  monitoring: MonitoringData;
  errors: ErrorLog[];
  isLoading: boolean;
}

const STATUS_COLORS = {
  healthy: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
};

function getStatusColor(errorRate: number) {
  if (errorRate < 0.01) return STATUS_COLORS.healthy;
  if (errorRate < 0.05) return STATUS_COLORS.warning;
  return STATUS_COLORS.error;
}

export default function MonitoringPage({ monitoring, errors, isLoading }: PageProps) {
  const [alerts, setAlerts] = useState<string[]>([]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand"></div>
      </div>
    );
  }

  const progress = (value: number, max: number) => {
    return {
      value: (value / max) * 100,
      max: 100,
      backgroundColor: "#e5e7eb",
      borderRadius: "9999px",
    };
  };

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
          <h1 className="text-lg font-semibold text-ink">Monitoring</h1>
          <p className="text-sm text-ink-3">System health, errors, and alerts</p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${monitoring.error_rate < 0.01 ? STATUS_COLORS.healthy : monitoring.error_rate < 0.05 ? STATUS_COLORS.warning : STATUS_COLORS.error}`}></div>
          <span className="text-sm text-ink">
            {monitoring.error_rate < 0.01 ? "Healthy" : monitoring.error_rate < 0.05 ? "Warning" : "Error"}
          </span>
        </div>
      </div>

      {/* System Health */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Uptime</p>
          <p className="text-2xl font-semibold text-ink">{monitoring.uptime}</p>
        </div>
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Memory Usage</p>
          <p className="text-2xl font-semibold text-ink">{monitoring.memory_usage}</p>
          <div className="mt-2 h-2 w-full rounded-full bg-line overflow-hidden">
            <div
              className="h-full rounded-full bg-brand"
              style={{ width: Math.min(100, parseFloat(monitoring.memory_usage) / 512 * 100) + "%" }}
            />
          </div>
        </div>
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">CPU Usage</p>
          <p className="text-2xl font-semibold text-ink">{monitoring.cpu_usage}</p>
          <div className="mt-2 h-2 w-full rounded-full bg-line overflow-hidden">
            <div
              className="h-full rounded-full bg-green-500"
              style={{ width: Math.min(100, parseFloat(monitoring.cpu_usage) * 2) + "%" }}
            />
          </div>
        </div>
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Active Connections</p>
          <p className="text-2xl font-semibold text-ink">{monitoring.active_connections}</p>
        </div>
      </div>

      {/* Requests & Errors */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Requests/Minute</p>
          <div className="mt-2 h-4 w-full rounded-full bg-line overflow-hidden">
            <div
              className="h-full rounded-full bg-brand"
              style={{ width: Math.min(100, (monitoring.requests_per_minute / 150) * 100) + "%" }}
            />
          </div>
          <p className="text-lg font-semibold text-ink mt-1">{monitoring.requests_per_minute}</p>
        </div>
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Error Rate</p>
          <div className="mt-2 h-4 w-full rounded-full bg-line overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: Math.min(100, monitoring.error_rate * 1000) + "%",
                backgroundColor: monitoring.error_rate < 0.01 ? "#10b981" : monitoring.error_rate < 0.05 ? "#f59e0b" : "#ef4444",
              }}
            />
          </div>
          <p className="text-lg font-semibold text-ink mt-1">{(monitoring.error_rate * 100).toFixed(2)}%</p>
        </div>
      </div>

      {/* Recent Errors */}
      <div className="rounded-xl border border-line bg-white shadow-card">
        <div className="px-4 py-3 border-b border-line flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink">Recent Errors</h2>
          <span className="text-xs text-ink-3">{errors.length} errors</span>
        </div>
        <div className="divide-y divide-line max-h-64 overflow-y-auto">
          {errors.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-ink-3">No errors recorded</p>
            </div>
          ) : (
            errors.map((error) => (
              <div key={error.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className={`w-2 h-2 rounded-full mt-1.5 ${error.level === "error" ? "bg-red-500" : "bg-amber-500"}`}></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-ink truncate">{error.message}</p>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-line text-ink-3">{error.level}</span>
                    </div>
                    <p className="text-xs text-ink-3 mt-1">{new Date(error.timestamp).toLocaleString()}</p>
                    <p className="text-xs text-ink-3">Source: {error.source} | Client: {error.client_id}</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Alerts */}
      <div className="rounded-xl border border-line bg-white shadow-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-ink">Latest Alert</h2>
          <button
            onClick={() => setAlerts([])}
            className="text-xs text-ink-3 hover:text-ink"
          >
            Clear
          </button>
        </div>
        {alerts.length === 0 ? (
          <p className="text-sm text-ink-3 text-center py-2">No active alerts</p>
        ) : (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{alerts[0]}</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const cookieStore = await cookies();
  const session = cookieStore.get("session");

  if (!session?.value) {
    return redirect("/login");
  }

  try {
    // Fetch monitoring data
    const monitoringResponse = await fetch("http://localhost:3000/api/v1/monitoring", {
      headers: {
        Authorization: `Bearer ${session.value}`,
      },
    });

    const monitoring = await monitoringResponse.json() as MonitoringData;

    // Fetch errors
    const errorsResponse = await fetch("http://localhost:3000/api/v1/admin/errors?limit=10", {
      headers: {
        Authorization: `Bearer ${session.value}`,
      },
    });

    const errorsData = await errorsResponse.json();
    const errors = errorsData.errors as ErrorLog[];

    return {
      props: {
        monitoring,
        errors,
        isLoading: false,
      },
    };
  } catch (error) {
    console.error("Failed to fetch monitoring:", error);
    return {
      props: {
        monitoring: {
          uptime: "0s",
          memory_usage: "0MB",
          cpu_usage: "0%",
          requests_per_minute: 0,
          error_rate: 0,
          active_connections: 0,
          last_error: null,
          last_updated: new Date().toISOString(),
        },
        errors: [],
        isLoading: false,
      },
    };
  }
};
