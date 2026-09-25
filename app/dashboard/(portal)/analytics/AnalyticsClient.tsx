"use client";

import { useCallback, useState } from "react";
import type { AnalyticsData } from "../../../../lib/omniflow/portal";

const statClass =
  "rounded-2xl border border-line bg-soft px-5 py-4";

const statLabel = "text-[10px] uppercase tracking-wider text-ink-3";
const statValue = "mt-1 text-lg font-semibold text-ink";

const chipBtn =
  "rounded-xl border px-3.5 py-1.5 text-xs font-medium transition-colors duration-300";

function intentLabel(intent: string): string {
  return intent.charAt(0).toUpperCase() + intent.slice(1).replace(/_/g, " ");
}

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value < 90) return Math.round(value) + "s";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  if (minutes < 60) {
    return seconds ? minutes + "m " + seconds + "s" : minutes + "m";
  }
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

export default function AnalyticsClient({
  initial,
}: {
  initial: AnalyticsData;
}) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/analytics?days=" + String(days),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as
        | (AnalyticsData & { error?: unknown })
        | null;
      if (payload && payload.totals && Array.isArray(payload.perDay)) {
        setData(payload);
      }
    } catch {
      // Keep showing the previous window on transient failures.
    } finally {
      setLoading(false);
    }
  }, []);

  const totals = data.totals;
  const window = data.window;
  const maxDay = Math.max(
    1,
    ...data.perDay.map((point) => point.inbound + point.outbound)
  );
  const maxIntent = Math.max(1, ...data.intents.map((item) => item.count));
  const dayLabelStep = data.perDay.length > 14 ? 5 : data.perDay.length > 7 ? 3 : 1;
  const isEmpty =
    totals.conversations === 0 &&
    totals.messagesIn === 0 &&
    totals.messagesOut === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 14, 30].map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => load(days)}
            disabled={loading}
            className={
              chipBtn +
              " " +
              (data.days === days
                ? "border-brand/25 bg-brand-soft text-brand"
                : "border-line bg-soft text-ink-3 hover:bg-soft") +
              (loading ? " opacity-50" : "")
            }
          >
            {days === data.days ? "Last " : ""}
            {days} days
          </button>
        ))}
      </div>

      {isEmpty ? (
        <div className="rounded-2xl border border-line bg-soft p-8 text-center">
          <p className="text-sm text-ink-3">No data yet</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Numbers appear here automatically as customers start chatting on
            WhatsApp.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className={statClass}>
              <p className={statLabel}>Customers</p>
              <p className={statValue}>{totals.customers}</p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Conversations</p>
              <p className={statValue}>{totals.conversations}</p>
              <p className="text-[10px] text-ink-3">
                {totals.conversationsClosed} closed
              </p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Messages in</p>
              <p className={statValue}>{totals.messagesIn}</p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Messages out</p>
              <p className={statValue}>{totals.messagesOut}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-soft p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">
                Messages per day
              </h2>
              <div className="flex items-center gap-3 text-[10px] text-ink-3">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-cyan-400" /> In
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" /> Out
                </span>
              </div>
            </div>
            <div className="mt-5 flex h-32 items-end gap-1">
              {data.perDay.map((point) => {
                const total = point.inbound + point.outbound;
                const heightPct = Math.round((total / maxDay) * 100);
                const inboundPct =
                  total === 0 ? 0 : Math.round((point.inbound / total) * 100);
                return (
                  <div
                    key={point.day}
                    title={point.day + " — in " + point.inbound + ", out " + point.outbound}
                    className="flex h-full flex-1 flex-col justify-end"
                  >
                    <div
                      className="flex w-full flex-col justify-end overflow-hidden rounded-t-md"
                      style={{ height: Math.max(total === 0 ? 2 : 6, heightPct) + "%" }}
                    >
                      <div
                        className="w-full bg-emerald-400/80"
                        style={{ height: String(100 - inboundPct) + "%" }}
                      />
                      <div
                        className="w-full bg-cyan-400/80"
                        style={{ height: String(inboundPct) + "%" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex gap-1">
              {data.perDay.map((point, index) => (
                <div key={point.day} className="flex-1 text-center">
                  {index % dayLabelStep === 0 ? (
                    <span className="text-[9px] text-ink-3">
                      {point.day.slice(8)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className={statClass}>
              <p className={statLabel}>Instant answers</p>
              <p className={statValue}>{window.instantAnswers}</p>
              <p className="text-[10px] text-ink-3">
                Knowledge-base replies
              </p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Follow-ups delivered</p>
              <p className={statValue}>{window.followupsDelivered}</p>
              <p className="text-[10px] text-ink-3">
                After customers went silent
              </p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Replies queued</p>
              <p className={statValue}>{window.repliesQueued}</p>
              <p className="text-[10px] text-ink-3">Manual team replies</p>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-soft p-6">
            <h2 className="text-sm font-semibold text-ink">Service level</h2>
            <p className="mt-0.5 text-xs text-ink-3">
              How fast the team responds and how many chats get resolved.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className={statClass}>
                <p className={statLabel}>Resolution rate</p>
                <p className={statValue}>
                  {data.service?.resolutionRate != null
                    ? data.service.resolutionRate.toFixed(1) + "%"
                    : "—"}
                </p>
                <p className="text-[10px] text-ink-3">
                  Chats created in this window that are now closed
                </p>
              </div>
              <div className={statClass}>
                <p className={statLabel}>Avg first response</p>
                <p className={statValue}>
                  {formatSeconds(data.service?.frtAvgSeconds)}
                </p>
                <p className="text-[10px] text-ink-3">
                  First inbound message → first reply
                </p>
              </div>
              <div className={statClass}>
                <p className={statLabel}>Median first response</p>
                <p className={statValue}>
                  {formatSeconds(data.service?.frtMedianSeconds)}
                </p>
                <p className="text-[10px] text-ink-3">
                  {data.service?.answeredConversations
                    ? data.service.answeredConversations + " chats answered in this window"
                    : "No replies yet in this window"}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-soft p-6">
            <h2 className="text-sm font-semibold text-ink">
              What customers ask about
            </h2>
            {data.intents.length === 0 ? (
              <p className="mt-3 text-xs text-ink-3">
                No classified messages in this window yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {data.intents.map((item) => (
                  <li key={item.intent}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink-2">
                        {intentLabel(item.intent)}
                      </span>
                      <span className="text-ink-3">{item.count}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-soft">
                      <div
                        className="h-full rounded-full bg-cyan-400/70"
                        style={{
                          width: Math.max(4, Math.round((item.count / maxIntent) * 100)) + "%",
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl border border-line bg-soft p-6">
            <h2 className="text-sm font-semibold text-ink">
              Most-used answers
            </h2>
            {data.topEntries.length === 0 ? (
              <p className="mt-3 text-xs text-ink-3">
                No knowledge-base answers have been sent yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-2.5">
                {data.topEntries.map((entry) => (
                  <li
                    key={entry.title}
                    className="flex items-center justify-between gap-4 text-xs"
                  >
                    <span className="min-w-0 truncate text-ink-2">
                      {entry.title}
                    </span>
                    <span className="shrink-0 text-ink-3">
                      sent {entry.usageCount}{" "}
                      {entry.usageCount === 1 ? "time" : "times"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
