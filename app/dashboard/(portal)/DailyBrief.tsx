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
  deadDeliveries: number;
  unreadAlerts: number;
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
      const [queue, radar, revenue, alerts, deliveries] = await Promise.all([
        getJson("/api/omniflow/portal/winback/queue"),
        getJson("/api/omniflow/portal/churn/radar?limit=1"),
        getJson("/api/omniflow/portal/revenue/summary?days=7"),
        getJson("/api/omniflow/portal/alerts"),
        getJson("/api/omniflow/portal/deliveries"),
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
      const deliveryCounts =
        deliveries !== null && deliveries.counts !== null &&
        typeof deliveries.counts === "object"
          ? (deliveries.counts as Record<string, unknown>)
          : {};
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
        deadDeliveries:
          num(deliveryCounts, "dead") + num(deliveryCounts, "failed"),
        unreadAlerts: alerts !== null ? num(alerts, "unread") : 0,
      });
    })();
    return () => {
      active = false;
    };
  }, []);

  if (failed || !brief) return null;

  return (
    <section className="mb-6 rounded-2xl border border-line bg-soft p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink">Today</p>
        <div className="flex gap-3 text-[10px]">
          <Link
            href="/dashboard/growth"
            className="text-brand hover:underline"
          >
            Growth
          </Link>
          <Link
            href="/dashboard/winback"
            className="text-brand hover:underline"
          >
            Win-back
          </Link>
          <Link
            href="/dashboard/customers"
            className="text-brand hover:underline"
          >
            Customers
          </Link>
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-ink-2">
        <li>
          Rs {brief.revenue.toLocaleString()} this week
          {brief.delta !== null ? (
            <span
              className={
                brief.delta >= 0 ? " text-ok" : " text-danger"
              }
            >
              {" "}
              ({brief.delta >= 0 ? "+" : ""}
              {brief.delta}% vs prior)
            </span>
          ) : null}
        </li>
        <li>
          <span className="text-amber-600">
            {brief.carts + brief.reorders} to recover
          </span>{" "}
          · {brief.carts} open carts, {brief.reorders} reorders due
          {brief.winbacks > 0 ? `, ${brief.winbacks} quiet payers` : ""}
        </li>
        {brief.atRisk > 0 ? (
          <li>
            <span className="text-danger">
              {brief.atRisk} customers cooling or at risk
            </span>
          </li>
        ) : null}
      </ul>
      {brief.deadDeliveries > 0 || brief.unreadAlerts > 0 ? (
        <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2">
          <p className="text-[11px] font-semibold text-amber-200">
            Needs attention
          </p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-ink-2">
            {brief.deadDeliveries > 0 ? (
              <li>
                {brief.deadDeliveries} delivery failure
                {brief.deadDeliveries === 1 ? "" : "s"} stuck in the queue —{" "}
                <Link
                  href="/dashboard/settings"
                  className="text-brand hover:underline"
                >
                  replay from Deliveries
                </Link>
              </li>
            ) : null}
            {brief.unreadAlerts > 0 ? (
              <li>
                {brief.unreadAlerts} unread alert
                {brief.unreadAlerts === 1 ? "" : "s"} on the bell
              </li>
            ) : null}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-3">
            <span className="font-semibold text-ink-3">
              Recommended:
            </span>{" "}
            {brief.deadDeliveries > 0
              ? "replay the failed sends so customers are not left waiting."
              : "clear the bell so real failures stay visible."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
