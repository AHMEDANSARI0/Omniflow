"use client";

import { useCallback, useEffect, useState } from "react";

interface PerfReport {
  counts: {
    conversations: number;
    messages: number;
    actions: number;
    checkout_links: number;
  };
  timings_ms: {
    recent_conversations: number;
    recent_messages: number;
    open_links: number;
  };
  indexes: string[];
  hot_indexes_present: string[];
  missing_hot_indexes: string[];
  ok: boolean;
}

/**
 * Performance (B12): a live read-only speed report - row counts,
 * the measured milliseconds of the three hottest dashboard queries,
 * and confirmation that the hot database indexes exist. Pure
 * diagnostics; nothing here changes behaviour.
 */
export default function PerfCard() {
  const [report, setReport] = useState<PerfReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/perf",
        { cache: "no-store" });
      if (response.ok) {
        setReport((await response.json()) as PerfReport);
      }
    } catch {
      /* keep the previous report */
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function ms(value: number): string {
    return value < 1 ? "<1 ms" : value + " ms";
  }

  return (
    <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Performance</p>
        <div className="flex items-center gap-2">
          {report ? (
            <span
              className={
                "rounded-full border px-2.5 py-1 text-[11px] " +
                (report.ok
                  ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-200"
                  : "border-amber-400/30 bg-amber-400/[0.08] text-amber-200")
              }
            >
              {report.ok ? "Indexes healthy" : "Index missing"}
            </span>
          ) : null}
          <button
            onClick={() => void load()}
            disabled={busy}
            className="text-[11px] text-cyan-300 hover:underline disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Live speed report - the dashboard ki sab se heavy queries ka
        waqt (milliseconds) aur data ka size.
      </p>

      {report ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-2.5">
            <p className="text-[11px] text-slate-500">Conversations</p>
            <p className="text-sm text-slate-200">
              {report.counts.conversations}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              recent 10: {ms(report.timings_ms.recent_conversations)}
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-2.5">
            <p className="text-[11px] text-slate-500">Messages</p>
            <p className="text-sm text-slate-200">
              {report.counts.messages}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              recent 20: {ms(report.timings_ms.recent_messages)}
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-2.5">
            <p className="text-[11px] text-slate-500">Open orders</p>
            <p className="text-sm text-slate-200">
              {report.counts.checkout_links}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              open 10: {ms(report.timings_ms.open_links)}
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-slate-500">Loading...</p>
      )}
      {report && !report.ok ? (
        <p className="mt-2 text-[11px] text-amber-300">
          Missing: {report.missing_hot_indexes.join(", ")} - the CP
          creates them automatically; try Refresh after a restart.
        </p>
      ) : null}
    </section>
  );
}
