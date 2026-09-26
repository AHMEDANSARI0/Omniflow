"use client";

import { useCallback, useEffect, useState } from "react";

interface WeeklySummary {
  chats: number;
  messagesIn: number;
  messagesOut: number;
  codConfirmed: number;
  codDeclined: number;
  broadcasts: number;
  csatAsked: number;
  csatAvg: number | null;
  days: { day: string; chats: number; inbound: number }[];
}

function dayLabel(iso: string): string {
  const stamp = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(stamp)) return iso;
  return new Intl.DateTimeFormat("en", { weekday: "short" }).format(stamp);
}

export default function WeeklyPage() {
  const [summary, setSummary] = useState<WeeklySummary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/omniflow/portal/insights/weekly", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        chats?: number;
        messages_in?: number;
        messages_out?: number;
        cod_confirmed?: number;
        cod_declined?: number;
        broadcasts?: number;
        csat_asked?: number;
        csat_avg?: number | null;
        days?: { day?: string; chats?: number; inbound?: number }[];
      } | null;
      if (payload && typeof payload === "object" && Array.isArray(payload.days)) {
        setSummary({
          chats: payload.chats ?? 0,
          messagesIn: payload.messages_in ?? 0,
          messagesOut: payload.messages_out ?? 0,
          codConfirmed: payload.cod_confirmed ?? 0,
          codDeclined: payload.cod_declined ?? 0,
          broadcasts: payload.broadcasts ?? 0,
          csatAsked: payload.csat_asked ?? 0,
          csatAvg:
            typeof payload.csat_avg === "number" ? payload.csat_avg : null,
          days: payload.days.map((day) => ({
            day: typeof day.day === "string" ? day.day : "",
            chats: typeof day.chats === "number" ? day.chats : 0,
            inbound: typeof day.inbound === "number" ? day.inbound : 0,
          })),
        });
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const peak = Math.max(
    1,
    ...(summary?.days ?? []).map((day) => Math.max(day.chats, day.inbound))
  );

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-brand/70">
          Workspace
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Weekly summary
        </h1>
        <p className="mt-1.5 text-sm text-ink-3">
          The last 7 days at a glance — chats, messages, orders and ratings.
        </p>

        {failed ? (
          <p className="mt-6 text-sm text-ink-3">
            The summary is unavailable right now.
          </p>
        ) : summary === null ? (
          <p className="mt-6 text-sm text-ink-3">Loading\\u2026</p>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "New chats", value: summary.chats },
                { label: "Messages in", value: summary.messagesIn },
                { label: "Messages out", value: summary.messagesOut },
                { label: "Broadcasts", value: summary.broadcasts },
                { label: "COD confirmed", value: summary.codConfirmed },
                { label: "COD declined", value: summary.codDeclined },
                { label: "Ratings asked", value: summary.csatAsked },
                {
                  label: "Avg rating",
                  value: summary.csatAvg === null ? "\\u2014" : summary.csatAvg,
                },
              ].map((tile) => (
                <div
                  key={tile.label}
                  className="rounded-2xl border border-line bg-soft p-3 text-center"
                >
                  <p className="text-xl font-semibold text-ink">{tile.value}</p>
                  <p className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-3">
                    {tile.label}
                  </p>
                </div>
              ))}
            </div>

            <section className="mt-4 rounded-2xl border border-line bg-soft p-4">
              <p className="text-xs font-semibold text-ink">Day by day</p>
              <ul className="mt-3 space-y-2">
                {summary.days.map((day) => (
                  <li key={day.day} className="flex items-center gap-3">
                    <span className="w-10 shrink-0 text-[11px] text-ink-3">
                      {dayLabel(day.day)}
                    </span>
                    <span className="flex-1">
                      <span className="flex h-2 items-center gap-0.5">
                        <span
                          className="h-2 rounded-l bg-cyan-400/70"
                          style={{
                            width: Math.round((day.inbound / peak) * 70) + "%",
                          }}
                        />
                        <span
                          className="h-2 rounded-r bg-emerald-400/60"
                          style={{
                            width: Math.round((day.chats / peak) * 30) + "%",
                          }}
                        />
                      </span>
                    </span>
                    <span className="w-24 shrink-0 text-right text-[11px] text-ink-3">
                      {day.inbound} in \\u00b7 {day.chats} chats
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[10px] text-ink-3">
                Cyan = customer messages, green = new chats.
              </p>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
