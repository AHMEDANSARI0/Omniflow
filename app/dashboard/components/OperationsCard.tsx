"use client";

import { useEffect, useState } from "react";

interface OperationsSnapshot {
  chats: { new: number; open: number; total: number };
  messages: { received: number; sent: number };
  orders: { paid: number; revenue: number };
  deliveries: { bookings: number; by_status: Record<string, number> };
  recovery: { open: number; resolved: number };
  csat: { answers: number; avg_score: number | null };
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3.5 py-3">
      <p className="text-[10px] uppercase tracking-wider text-slate-600">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
      {sub ? (
        <p className="mt-0.5 text-[10px] text-slate-500">{sub}</p>
      ) : null}
    </div>
  );
}

/**
 * One call, whole business: chats, messages, paid orders, courier
 * deliveries, recovery queue and CSAT for the last 30 days - the
 * consolidated operations analytics on the dashboard.
 */
export default function OperationsCard() {
  const [ops, setOps] = useState<OperationsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await fetch(
          "/api/omniflow/portal/insights/operations",
          { cache: "no-store" }
        );
        if (!alive) return;
        if (response.ok) {
          const payload = (await response.json()) as {
            operations?: OperationsSnapshot;
          };
          setOps(payload.operations ?? null);
        } else {
          setFailed(true);
        }
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (failed) return null;

  return (
    <div className="mb-8 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">
          Operations &mdash; last 30 days
        </h2>
        <span className="text-[10px] text-slate-600">
          chats &middot; orders &middot; deliveries &middot; recovery
          &middot; CSAT
        </span>
      </div>

      {!ops ? (
        <div
          className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
          aria-busy="true"
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={String(index)}
              className="h-[76px] animate-pulse rounded-xl bg-white/5"
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile
            label="Paid orders"
            value={String(ops.orders.paid)}
            sub={"Rs " + ops.orders.revenue.toLocaleString() + " revenue"}
          />
          <Tile
            label="New chats"
            value={String(ops.chats.new)}
            sub={ops.chats.open + " open now"}
          />
          <Tile
            label="Messages"
            value={String(ops.messages.received + ops.messages.sent)}
            sub={ops.messages.received + " in \u00b7 "
              + ops.messages.sent + " out"}
          />
          <Tile
            label="Courier bookings"
            value={String(ops.deliveries.bookings)}
            sub={
              (ops.deliveries.by_status.delivered ?? 0) + " delivered"
            }
          />
          <Tile
            label="Recovery"
            value={String(ops.recovery.open)}
            sub={ops.recovery.resolved + " resolved"}
          />
          <Tile
            label="CSAT"
            value={ops.csat.avg_score !== null
              ? ops.csat.avg_score.toFixed(1) + " / 5"
              : "\u2014"}
            sub={ops.csat.answers + " answers"}
          />
        </div>
      )}
    </div>
  );
}
