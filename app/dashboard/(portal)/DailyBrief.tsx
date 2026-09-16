"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface BriefData {
  carts: number;
  reorders: number;
  winbacks: number;
  atRisk: number;
  revenue: number;
  delta: number | null;
}

export default function DailyBrief() {
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const getJson = async (
        url: string
      ): Promise<Record<string, unknown> | null> => {
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) return null;
          const payload = await response.json().catch(() => null);
          return payload !== null && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      };
      const [queue, radar, revenue] = await Promise.all([
        getJson("/api/omniflow/portal/winback/queue"),
        getJson("/api/omniflow/portal/churn/radar?limit=1"),
        getJson("/api/omniflow/portal/revenue/summary?days=7"),
      ]);
      if (!active) return;
      if (!queue && !radar && !revenue) {
        setFailed(true);
        return;
      }
      const queueCounts =
        queue !== null && queue.counts !== null &&
        typeof queue.counts === "object"
          ? (queue.counts as Record<string, unknown>)
          : {};
      const radarCounts =
        radar !== null && radar.counts !== null &&
        typeof radar.counts === "object"
          ? (radar.counts as Record<string, unknown>)
          : {};
      const num = (raw: Record<string, unknown>, key: string): number =>
        typeof raw[key] === "number" ? (raw[key] as number) : 0;
      setBrief({
        carts: num(queueCounts, "cart"),
        reorders: num(queueCounts, "reorder"),
        winbacks: num(queueCounts, "winback"),
        atRisk: num(radarCounts, "at_risk") + num(radarCounts, "cooling"),
        revenue: revenue !== null ? num(revenue, "revenue") : 0,
        delta:
          revenue !== null && typeof revenue.delta_percent === "number"
            ? (revenue.delta_percent as number)
            : null,
      });
    })();
    return () => {
      active = false;
    };
  }, []);

  if (failed || !brief) return null;

  return (
    <section className="mb-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Today</p>
        <div className="flex gap-3 text-[10px]">
          <Link
            href="/dashboard/growth"
            className="text-cyan-300 hover:underline"
          >
            Growth
          </Link>
          <Link
            href="/dashboard/winback"
            className="text-cyan-300 hover:underline"
          >
            Win-back
          </Link>
          <Link
            href="/dashboard/customers"
            className="text-cyan-300 hover:underline"
          >
            Customers
          </Link>
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-slate-300">
        <li>
          Rs {brief.revenue.toLocaleString()} this week
          {brief.delta !== null ? (
            <span
              className={
                brief.delta >= 0 ? " text-emerald-300" : " text-rose-300"
              }
            >
              {" "}
              ({brief.delta >= 0 ? "+" : ""}
              {brief.delta}% vs prior)
            </span>
          ) : null}
        </li>
        <li>
          <span className="text-amber-300">
            {brief.carts + brief.reorders} to recover
          </span>{" "}
          · {brief.carts} open carts, {brief.reorders} reorders due
          {brief.winbacks > 0 ? `, ${brief.winbacks} quiet payers` : ""}
        </li>
        {brief.atRisk > 0 ? (
          <li>
            <span className="text-rose-300">
              {brief.atRisk} customers cooling or at risk
            </span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
