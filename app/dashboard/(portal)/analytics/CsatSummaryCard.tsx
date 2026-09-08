"use client";

import { useCallback, useEffect, useState } from "react";

interface CsatSummary {
  average: number | null;
  total: number;
  pending: number;
  dist: number[];
}

export default function CsatSummaryCard() {
  const [summary, setSummary] = useState<CsatSummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/csat/summary", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as CsatSummary | null;
      if (payload) {
        setSummary(payload);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — reloading the page retries.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded || !summary || (summary.total === 0 && summary.pending === 0)) {
    return null;
  }

  const maxCount = Math.max(1, ...summary.dist);

  return (
    <div className="mt-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xs font-semibold text-white">Customer rating (CSAT)</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            From 1–5 replies customers send on WhatsApp.
            {summary.pending > 0
              ? " " + String(summary.pending) + " request" + (summary.pending === 1 ? "" : "s") + " waiting."
              : ""}
          </p>
        </div>
        <p className="text-2xl font-semibold text-white">
          {summary.average !== null ? String(summary.average) : "—"}
          <span className="ml-1 text-xs font-normal text-slate-500">/ 5</span>
        </p>
      </div>
      <div className="mt-4 space-y-1.5">
        {[5, 4, 3, 2, 1].map((score) => {
          const count = summary.dist[score - 1] ?? 0;
          return (
            <div key={score} className="flex items-center gap-2">
              <span className="w-3 shrink-0 text-right text-[10px] text-slate-600">
                {String(score)}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.04]">
                <div
                  className={
                    "h-full rounded-full " +
                    (score >= 4 ? "bg-emerald-400/50" : score === 3 ? "bg-amber-400/50" : "bg-red-400/50")
                  }
                  style={{ width: String(Math.round((count / maxCount) * 100)) + "%" }}
                />
              </div>
              <span className="w-6 shrink-0 text-[10px] text-slate-500">
                {String(count)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
