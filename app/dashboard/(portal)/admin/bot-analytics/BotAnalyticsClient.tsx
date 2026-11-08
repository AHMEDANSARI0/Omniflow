"use client";

import { motion } from "motion/react";
import React, { useState } from "react";

export interface ClientMetric {
  client_id: string;
  client_name: string;
  total_messages: number;
  avg_response_delay: number;
  avg_response_time: number;
  satisfaction_score: number;
  recent_messages: Array<{
    id: string;
    direction: string;
    body: string;
    created_at: string;
  }>;
}

export interface AnalyticsData {
  total_clients: number;
  total_messages: number;
  avg_response_delay: number;
  avg_response_time: number;
  overall_satisfaction: number;
  clients: ClientMetric[];
  recent_activity: Array<{
    client_id: string;
    client_name: string;
    direction: string;
    body: string;
    created_at: string;
  }>;
  updated_at: string;
}

interface PageProps {
  analytics: AnalyticsData;
  isLoading: boolean;
}

const COLORS = {
  instant: "bg-emerald-500",
  fast: "bg-green-500",
  medium: "bg-amber-500",
  slow: "bg-red-500",
};

function getDelayColor(delay: number) {
  if (delay === 0) return COLORS.instant;
  if (delay <= 60) return COLORS.fast;
  if (delay <= 300) return COLORS.medium;
  return COLORS.slow;
}

function formatDelay(seconds: number) {
  if (seconds === 0) return "Instant";
  if (seconds < 60) return seconds + "s";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins + "m " + secs + "s";
}

function formatTime(seconds: number) {
  if (seconds < 60) return seconds + "s";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round((seconds % 60) * 10) / 10;
  return mins + "m " + secs + "s";
}

export default function BotAnalyticsPage({ analytics, isLoading }: PageProps) {
  const [selectedClient, setSelectedClient] = useState<ClientMetric | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand"></div>
      </div>
    );
  }

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
          <h1 className="text-lg font-semibold text-ink">Bot Analytics</h1>
          <p className="text-sm text-ink-3">Response time, satisfaction metrics, and activity</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-ink-3">Last updated</p>
          <p className="text-sm text-ink">{new Date(analytics.updated_at).toLocaleString()}</p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Total Clients</p>
          <p className="text-2xl font-semibold text-ink">{analytics.total_clients}</p>
        </div>
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Total Messages</p>
          <p className="text-2xl font-semibold text-ink">{analytics.total_messages.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Avg Response Delay</p>
          <p className="text-2xl font-semibold text-ink">{formatDelay(analytics.avg_response_delay)}</p>
        </div>
        <div className="rounded-xl border border-line bg-white shadow-card p-4">
          <p className="text-xs text-ink-3 mb-1">Avg Response Time</p>
          <p className="text-2xl font-semibold text-ink">{formatTime(analytics.avg_response_time)}</p>
        </div>
      </div>

      {/* Overall Satisfaction */}
      <div className="rounded-xl border border-line bg-white shadow-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-ink mb-2">Overall Satisfaction</h2>
            <p className="text-3xl font-semibold text-ink">{analytics.overall_satisfaction.toFixed(1)}%</p>
          </div>
          <div className="h-12 w-32 rounded-full bg-line">
            <div
              className="h-full rounded-full"
              style={{
                width: analytics.overall_satisfaction + "%",
                backgroundColor:
                  analytics.overall_satisfaction >= 80
                    ? "#10b981"
                    : analytics.overall_satisfaction >= 50
                    ? "#f59e0b"
                    : "#ef4444",
              }}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-center">
          <span className="text-xs text-ink-3">
            {analytics.overall_satisfaction >= 80
              ? "Excellent"
              : analytics.overall_satisfaction >= 50
              ? "Good"
              : "Needs improvement"}
          </span>
        </div>
      </div>

      {/* Client Details */}
      <div className="rounded-xl border border-line bg-white shadow-card">
        <div className="px-4 py-3 border-b border-line">
          <h2 className="text-sm font-medium text-ink">Per-Client Metrics</h2>
          <p className="text-xs text-ink-3">Click on a client for details</p>
        </div>
        <div className="divide-y divide-line">
          {analytics.clients.map((client) => (
            <div
              key={client.client_id}
              className="px-4 py-3 hover:bg-soft cursor-pointer"
              onClick={() => setSelectedClient(client)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-ink">{client.client_name}</p>
                  <p className="text-xs text-ink-3">Client ID: {client.client_id}</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <p className="text-xs text-ink-3">Delay</p>
                    <p className="text-sm font-medium text-ink">{formatDelay(client.avg_response_delay)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-ink-3">Response Time</p>
                    <p className="text-sm font-medium text-ink">{formatTime(client.avg_response_time)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-ink-3">Satisfaction</p>
                    <p className="text-sm font-medium text-ink">{client.satisfaction_score.toFixed(1)}%</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-ink-3">Messages</p>
                    <p className="text-sm font-medium text-ink">{client.total_messages}</p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Selected Client Details */}
      {selectedClient && (
        <div className="rounded-xl border border-line bg-white shadow-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-medium text-ink">{selectedClient.client_name}</h2>
              <p className="text-xs text-ink-3">Client ID: {selectedClient.client_id}</p>
            </div>
            <button
              onClick={() => setSelectedClient(null)}
              className="text-xs text-ink-3 hover:text-ink"
            >
              Close
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="rounded-lg border border-line bg-soft p-3">
              <p className="text-xs text-ink-3 mb-1">Avg Delay</p>
              <p className="text-lg font-semibold text-ink">{formatDelay(selectedClient.avg_response_delay)}</p>
            </div>
            <div className="rounded-lg border border-line bg-soft p-3">
              <p className="text-xs text-ink-3 mb-1">Avg Response Time</p>
              <p className="text-lg font-semibold text-ink">{formatTime(selectedClient.avg_response_time)}</p>
            </div>
            <div className="rounded-lg border border-line bg-soft p-3">
              <p className="text-xs text-ink-3 mb-1">Satisfaction</p>
              <p className="text-lg font-semibold text-ink">{selectedClient.satisfaction_score.toFixed(1)}%</p>
            </div>
            <div className="rounded-lg border border-line bg-soft p-3">
              <p className="text-xs text-ink-3 mb-1">Messages</p>
              <p className="text-lg font-semibold text-ink">{selectedClient.total_messages}</p>
            </div>
          </div>

          {/* Recent Messages */}
          <div className="border-t border-line pt-4">
            <h3 className="text-sm font-medium text-ink mb-3">Recent Activity</h3>
            <div className="space-y-2">
              {selectedClient.recent_messages.length === 0 ? (
                <p className="text-sm text-ink-3 text-center py-4">No recent messages</p>
              ) : (
                selectedClient.recent_messages.map((msg) => (
                  <div
                    key={msg.id}
                    className="flex items-start gap-3 p-3 rounded-lg border border-line bg-soft"
                  >
                    <div className="flex-shrink-0">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium text-white ${msg.direction === "in" ? "bg-brand" : "bg-green-500"}`}>
                        {msg.direction === "in" ? "IN" : "OUT"}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink truncate">{msg.body}</p>
                      <p className="text-xs text-ink-3 mt-1">{new Date(msg.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
