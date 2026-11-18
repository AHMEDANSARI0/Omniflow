"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface DailyPoint {
  dateKey: string;
  label: string;
  conversations: number;
  automated: number;
  handovers: number;
}

interface LiveWorkspaceSummary {
  waState: "connected" | "connecting" | "disconnected";
  waPhone: string | null;
  businessName: string;
  preferredLanguage: string;
  activeRulesCount: number;
  totalConversations: number;
  openConversations: number;
  closedConversations: number;
  needsReply: number;
  totalCustomers: number;
  receivedMessages: number;
  sentMessages: number;
  ruleReplies: number;
  aiReplies: number;
  humanHandovers: number;
  dailyMsgUsed: number;
  dailyMsgLimit: number;
  monthlyAiUsed: number;
  monthlyAiLimit: number;
  dailySeries: DailyPoint[];
}

function buildLast7DaysSeries(
  conversations: { lastMessageAt?: string | null; createdAt?: string | null; status?: string; needsReply?: boolean }[],
  hybridStats: { received: number; ruleReplies: number; aiReplies: number; humanHandovers: number }
): DailyPoint[] {
  const days: DailyPoint[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    days.push({
      dateKey,
      label,
      conversations: 0,
      automated: 0,
      handovers: 0,
    });
  }

  const map = new Map(days.map((d) => [d.dateKey, d]));
  for (const conv of conversations) {
    const ts = conv.lastMessageAt || conv.createdAt;
    if (!ts) continue;
    const key = ts.slice(0, 10);
    const bucket = map.get(key);
    if (bucket) {
      bucket.conversations += 1;
      if (conv.needsReply) {
        bucket.handovers += 1;
      } else {
        bucket.automated += 1;
      }
    }
  }

  // Also include today's live hybrid execution counts so testing or live runs reflect immediately on today's bar
  const todayBucket = days[days.length - 1];
  if (todayBucket) {
    const totalAuto = hybridStats.ruleReplies + hybridStats.aiReplies;
    if (totalAuto > todayBucket.automated) {
      todayBucket.automated = totalAuto;
    }
    if (hybridStats.received > todayBucket.conversations) {
      todayBucket.conversations = hybridStats.received;
    }
    if (hybridStats.humanHandovers > todayBucket.handovers) {
      todayBucket.handovers = hybridStats.humanHandovers;
    }
  }

  return days;
}

export default function LivePortalStats() {
  const [summary, setSummary] = useState<LiveWorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const [waRes, convRes, custRes, hybRes, entRes] = await Promise.all([
        fetch("/api/omniflow/portal/channels/whatsapp", { cache: "no-store" }).catch(() => null),
        fetch("/api/omniflow/portal/conversations?limit=50", { cache: "no-store" }).catch(() => null),
        fetch("/api/omniflow/portal/customers?limit=50", { cache: "no-store" }).catch(() => null),
        fetch("/api/omniflow/portal/hybrid-automation", { cache: "no-store" }).catch(() => null),
        fetch("/api/omniflow/portal/entitlements", { cache: "no-store" }).catch(() => null),
      ]);

      const [waJson, convJson, custJson, hybJson, entJson] = await Promise.all([
        waRes && waRes.ok ? waRes.json().catch(() => null) : null,
        convRes && convRes.ok ? convRes.json().catch(() => null) : null,
        custRes && custRes.ok ? custRes.json().catch(() => null) : null,
        hybRes && hybRes.ok ? hybRes.json().catch(() => null) : null,
        entRes && entRes.ok ? entRes.json().catch(() => null) : null,
      ]);

      const waState: "connected" | "connecting" | "disconnected" =
        waJson?.state === "connected" || waJson?.state === "connecting"
          ? waJson.state
          : "disconnected";
      const waPhone: string | null = waJson?.phone ?? null;

      const convList = Array.isArray(convJson?.conversations)
        ? (convJson.conversations as {
            lastMessageAt?: string | null;
            createdAt?: string | null;
            status?: string;
            needsReply?: boolean;
          }[])
        : [];
      const totalConversations = convList.length;
      const openConversations = convList.filter((c) => c.status === "open").length;
      const closedConversations = Math.max(0, totalConversations - openConversations);
      const needsReply =
        typeof convJson?.counts?.needsReply === "number"
          ? convJson.counts.needsReply
          : convList.filter((c) => c.needsReply).length;
      const totalCustomers = Array.isArray(custJson?.customers)
        ? custJson.customers.length
        : 0;

      const hStats = {
        received: Number(hybJson?.stats?.received || totalConversations),
        sent: Number(hybJson?.stats?.sent || 0),
        ruleReplies: Number(hybJson?.stats?.ruleReplies || 0),
        aiReplies: Number(hybJson?.stats?.aiReplies || 0),
        humanHandovers: Number(hybJson?.stats?.humanHandovers || needsReply),
      };

      const rulesArr = Array.isArray(hybJson?.rules) ? hybJson.rules : [];
      const activeRulesCount = rulesArr.filter(
        (r: { enabled?: boolean }) => r && r.enabled
      ).length;

      const quotas = entJson?.entitlements?.quotas || {};
      const dailyMsgUsed = Number(quotas.daily_messages?.used || hStats.sent);
      const dailyMsgLimit = Number(quotas.daily_messages?.limit || 500);
      const monthlyAiUsed = Number(quotas.monthly_ai_replies?.used || hStats.aiReplies);
      const monthlyAiLimit = Number(quotas.monthly_ai_replies?.limit || 1000);

      setSummary({
        waState,
        waPhone,
        businessName:
          hybJson?.businessConfig?.businessName || "WhatsApp Business Desk",
        preferredLanguage:
          hybJson?.businessConfig?.preferredLanguage || "auto",
        activeRulesCount,
        totalConversations,
        openConversations,
        closedConversations,
        needsReply,
        totalCustomers,
        receivedMessages: hStats.received,
        sentMessages: hStats.sent,
        ruleReplies: hStats.ruleReplies,
        aiReplies: hStats.aiReplies,
        humanHandovers: hStats.humanHandovers,
        dailyMsgUsed,
        dailyMsgLimit,
        monthlyAiUsed,
        monthlyAiLimit,
        dailySeries: buildLast7DaysSeries(convList, hStats),
      });
    } catch {
      // keep previous state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats();
    const id = setInterval(() => void fetchStats(), 30_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  if (loading || !summary) {
    return (
      <div className="mb-6 flex items-center justify-center rounded-2xl border border-line bg-white py-8 shadow-card">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        <span className="ml-2.5 text-xs text-ink-3">
          Loading business & automation analytics...
        </span>
      </div>
    );
  }

  const totalAutomated = summary.ruleReplies + summary.aiReplies;
  const totalHandled = Math.max(
    1,
    totalAutomated + summary.humanHandovers
  );
  const rulePct = Math.round((summary.ruleReplies / totalHandled) * 100);
  const aiPct = Math.round((summary.aiReplies / totalHandled) * 100);
  const handoverPct = Math.round((summary.humanHandovers / totalHandled) * 100);
  const automationRate =
    summary.receivedMessages > 0
      ? Math.min(100, Math.round((totalAutomated / summary.receivedMessages) * 100))
      : totalAutomated > 0
        ? 100
        : 0;

  // SVG Chart geometry
  const chartW = 640;
  const chartH = 190;
  const padL = 32;
  const padR = 16;
  const padT = 16;
  const padB = 34;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const maxVal = Math.max(
    4,
    ...summary.dailySeries.map((d) =>
      Math.max(d.conversations, d.automated, d.handovers)
    )
  );

  const stepX =
    summary.dailySeries.length > 1
      ? plotW / (summary.dailySeries.length - 1)
      : plotW;

  const convPoints = summary.dailySeries
    .map((d, idx) => {
      const x = padL + idx * stepX;
      const y = padT + plotH - (d.conversations / maxVal) * plotH;
      return `${x},${y}`;
    })
    .join(" ");

  const convArea =
    summary.dailySeries.length > 0
      ? `M ${padL},${padT + plotH} L ` +
        summary.dailySeries
          .map((d, idx) => {
            const x = padL + idx * stepX;
            const y = padT + plotH - (d.conversations / maxVal) * plotH;
            return `${x},${y}`;
          })
          .join(" L ") +
        ` L ${padL + (summary.dailySeries.length - 1) * stepX},${padT + plotH} Z`
      : "";

  const dailyQuotaPct = Math.min(
    100,
    Math.round((summary.dailyMsgUsed / Math.max(1, summary.dailyMsgLimit)) * 100)
  );
  const monthlyAiQuotaPct = Math.min(
    100,
    Math.round((summary.monthlyAiUsed / Math.max(1, summary.monthlyAiLimit)) * 100)
  );

  return (
    <div className="mb-8 space-y-6">
      {/* Row 1: 6 Executive KPI Cards */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-6">
        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              WhatsApp Status
            </p>
            <span
              className={`h-2 w-2 rounded-full ${
                summary.waState === "connected"
                  ? "bg-emerald-500"
                  : summary.waState === "connecting"
                    ? "bg-amber-500 animate-pulse"
                    : "bg-ink-3"
              }`}
            />
          </div>
          <p className="mt-1.5 text-lg font-semibold text-ink capitalize">
            {summary.waState}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-ink-3">
            {summary.waPhone || "Link number in Setup"}
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Conversations
          </p>
          <p className="mt-1.5 text-lg font-semibold text-ink">
            {summary.totalConversations}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {summary.openConversations} open · {summary.closedConversations} resolved
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Customers
          </p>
          <p className="mt-1.5 text-lg font-semibold text-ink">
            {summary.totalCustomers}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {summary.needsReply} awaiting reply
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Automated Replies
          </p>
          <p className="mt-1.5 text-lg font-semibold text-brand">
            {totalAutomated}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {automationRate}% automation rate
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Rule vs AI Split
          </p>
          <p className="mt-1.5 text-lg font-semibold text-emerald-700">
            {summary.ruleReplies} / {summary.aiReplies}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {summary.ruleReplies} Rule · {summary.aiReplies} AI
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Active Rules
          </p>
          <p className="mt-1.5 text-lg font-semibold text-ink">
            {summary.activeRulesCount}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Lang: {summary.preferredLanguage.replace("_", " ").toUpperCase()}
          </p>
        </div>
      </div>

      {/* Row 2: 7-Day Business & Automation Chart + Resolution & Quota Breakdown */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* 7-Day Chart (2/3 width) */}
        <div className="rounded-2xl border border-line bg-white p-5 shadow-card lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Business & Automation Performance (Last 7 Days)
              </h2>
              <p className="mt-0.5 text-xs text-ink-3">
                Daily customer conversations compared with automated Rule + AI replies and human handovers.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-brand" />
                Conversations
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                Automated (Rule + AI)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                Awaiting Human
              </span>
            </div>
          </div>

          <div className="mt-4 w-full overflow-x-auto">
            <svg
              viewBox={`0 0 ${chartW} ${chartH}`}
              className="h-52 w-full min-w-[460px]"
              role="img"
              aria-label="7-day business and automation analytics chart"
            >
              <defs>
                <linearGradient id="ofConvGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* Horizontal Grid Lines & Y-Axis Labels */}
              {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
                const y = padT + plotH - ratio * plotH;
                const val = Math.round(ratio * maxVal);
                return (
                  <g key={idx}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={chartW - padR}
                      y2={y}
                      stroke="#e2e8f0"
                      strokeDasharray={ratio === 0 ? undefined : "3 3"}
                      strokeWidth="1"
                    />
                    <text
                      x={padL - 8}
                      y={y + 3}
                      textAnchor="end"
                      className="fill-slate-400 text-[9px]"
                    >
                      {val}
                    </text>
                  </g>
                );
              })}

              {/* Area under Conversations line */}
              {convArea && <path d={convArea} fill="url(#ofConvGrad)" />}

              {/* Conversations Trend Line */}
              {convPoints && (
                <polyline
                  fill="none"
                  stroke="#4f46e5"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={convPoints}
                />
              )}

              {/* Daily Grouped Bars & Data Points */}
              {summary.dailySeries.map((d, idx) => {
                const cx = padL + idx * stepX;
                const convY = padT + plotH - (d.conversations / maxVal) * plotH;
                const autoH = (d.automated / maxVal) * plotH;
                const handH = (d.handovers / maxVal) * plotH;
                const barW = 10;

                return (
                  <g key={d.dateKey}>
                    {/* Automated Replies Bar (Emerald) */}
                    {d.automated > 0 && (
                      <rect
                        x={cx - barW - 1}
                        y={padT + plotH - autoH}
                        width={barW}
                        height={Math.max(3, autoH)}
                        rx="3"
                        fill="#10b981"
                        opacity="0.85"
                      >
                        <title>{`${d.label}: ${d.automated} Automated Replies`}</title>
                      </rect>
                    )}

                    {/* Handovers Bar (Amber) */}
                    {d.handovers > 0 && (
                      <rect
                        x={cx + 1}
                        y={padT + plotH - handH}
                        width={barW}
                        height={Math.max(3, handH)}
                        rx="3"
                        fill="#f59e0b"
                        opacity="0.85"
                      >
                        <title>{`${d.label}: ${d.handovers} Awaiting Human`}</title>
                      </rect>
                    )}

                    {/* Conversation Point Dot */}
                    <circle
                      cx={cx}
                      cy={convY}
                      r="3.5"
                      fill="#ffffff"
                      stroke="#4f46e5"
                      strokeWidth="2"
                    >
                      <title>{`${d.label}: ${d.conversations} Conversations`}</title>
                    </circle>

                    {/* X-Axis Day Label */}
                    <text
                      x={cx}
                      y={chartH - 10}
                      textAnchor="middle"
                      className="fill-slate-500 text-[9.5px] font-medium"
                    >
                      {d.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Right Card (1/3 width): Automation Resolution Split & Quotas */}
        <div className="rounded-2xl border border-line bg-white p-5 shadow-card flex flex-col justify-between space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              Automation Resolution Breakdown
            </h2>
            <p className="mt-0.5 text-xs text-ink-3">
              How incoming WhatsApp inquiries are resolved across your workspace.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-ink-2">
                    Deterministic Rule Replies
                  </span>
                  <span className="font-semibold text-brand">
                    {summary.ruleReplies} ({rulePct}%)
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-soft">
                  <div
                    className="h-full rounded-full bg-brand transition-all duration-500"
                    style={{ width: `${Math.max(rulePct, summary.ruleReplies > 0 ? 8 : 0)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-ink-2">
                    Contextual AI Assistant
                  </span>
                  <span className="font-semibold text-emerald-700">
                    {summary.aiReplies} ({aiPct}%)
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-soft">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${Math.max(aiPct, summary.aiReplies > 0 ? 8 : 0)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-ink-2">
                    Human Agent Handovers
                  </span>
                  <span className="font-semibold text-amber-700">
                    {summary.humanHandovers} ({handoverPct}%)
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-soft">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-500"
                    style={{ width: `${Math.max(handoverPct, summary.humanHandovers > 0 ? 8 : 0)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Plan Quota Meters */}
          <div className="border-t border-line pt-3.5 space-y-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Plan Usage & Quotas
            </p>
            <div>
              <div className="flex items-center justify-between text-[11px] text-ink-2">
                <span>Daily Outbound Messages</span>
                <span className="font-semibold text-ink">
                  {summary.dailyMsgUsed} / {summary.dailyMsgLimit}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-soft">
                <div
                  className="h-full rounded-full bg-brand/80"
                  style={{ width: `${dailyQuotaPct}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-[11px] text-ink-2">
                <span>Monthly AI Assistant Replies</span>
                <span className="font-semibold text-ink">
                  {summary.monthlyAiUsed} / {summary.monthlyAiLimit}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-soft">
                <div
                  className="h-full rounded-full bg-emerald-500/80"
                  style={{ width: `${monthlyAiQuotaPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Row 3: Active Automation Engine Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white px-5 py-3.5 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/[0.08] px-3 py-1 text-xs font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Hybrid Automation Active
          </span>
          <p className="text-xs text-ink-2">
            Business Profile:{" "}
            <strong className="font-semibold text-ink">
              {summary.businessName}
            </strong>{" "}
            · {summary.activeRulesCount} active rules · Language:{" "}
            <strong className="font-semibold text-ink">
              {summary.preferredLanguage.replace("_", " ").toUpperCase()}
            </strong>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/dashboard/bot"
            className="inline-flex h-8 items-center rounded-xl border border-line bg-soft px-3 text-xs font-medium text-ink-2 transition-colors hover:border-brand/30 hover:text-ink"
          >
            Configure AI →
          </Link>
          <Link
            href="/dashboard/rules"
            className="inline-flex h-8 items-center rounded-xl border border-line bg-soft px-3 text-xs font-medium text-ink-2 transition-colors hover:border-brand/30 hover:text-ink"
          >
            Automation Rules →
          </Link>
          <Link
            href="/dashboard/activity"
            className="inline-flex h-8 items-center rounded-xl border border-line bg-soft px-3 text-xs font-medium text-ink-2 transition-colors hover:border-brand/30 hover:text-ink"
          >
            Activity Log →
          </Link>
        </div>
      </div>
    </div>
  );
}
