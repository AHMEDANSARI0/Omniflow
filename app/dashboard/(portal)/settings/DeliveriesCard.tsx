"use client";

import { useCallback, useEffect, useState } from "react";

type DeliveryStatus = "pending" | "failed" | "dead" | "done";

interface DeliveryRow {
  id: number;
  kind: string;
  label: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  channel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface DeliveriesPayload {
  deliveries: DeliveryRow[];
  counts: Record<DeliveryStatus, number>;
}

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Queued",
  failed: "Retrying",
  dead: "Failed",
  done: "Delivered",
};

const STATUS_STYLES: Record<DeliveryStatus, string> = {
  pending: "border-sky-400/25 bg-sky-400/[0.07] text-sky-200",
  failed: "border-amber-400/25 bg-amber-400/[0.07] text-amber-200",
  dead: "border-rose-400/25 bg-rose-400/[0.07] text-rose-200",
  done: "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200",
};

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DeliveriesCard() {
  const [data, setData] = useState<DeliveriesPayload | null>(null);
  const [filter, setFilter] = useState<DeliveryStatus | "all">("all");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const query = filter === "all" ? "" : "?status=" + filter;
      const response = await fetch("/api/omniflow/portal/deliveries" + query, {
        cache: "no-store",
      });
      if (response.ok) {
        setData((await response.json()) as DeliveriesPayload);
      } else {
        setNote("Could not load deliveries. Try again shortly.");
      }
    } catch {
      setNote("Could not load deliveries. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function replay(id: number) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/deliveries/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (response.ok) {
        setNote("Re-queued — the connector will pick it up within a minute.");
        await load();
      } else {
        setNote("Replay failed. Try again shortly.");
      }
    } catch {
      setNote("Replay failed. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  const counts = data?.counts;
  const rows = data?.deliveries ?? [];
  const visible =
    filter === "all" ? rows : rows.filter((row) => row.status === filter);

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Deliveries</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Outbound WhatsApp queue — failed sends retry automatically with
            backoff; replay anything that ended up failed.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.04] disabled:opacity-50"
        >
          {busy ? "Loading..." : "Refresh"}
        </button>
      </div>

      {counts ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(Object.keys(STATUS_LABELS) as DeliveryStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => setFilter(filter === status ? "all" : status)}
              className={
                "rounded-lg border px-2 py-0.5 text-[11px] " +
                (filter === status
                  ? STATUS_STYLES[status]
                  : "border-white/[0.08] text-slate-400 hover:bg-white/[0.03]")
              }
            >
              {STATUS_LABELS[status]} · {counts[status] ?? 0}
            </button>
          ))}
        </div>
      ) : null}

      {note ? (
        <p className="mt-2 text-xs text-slate-400">{note}</p>
      ) : null}

      <div className="mt-3 space-y-1.5">
        {visible.length === 0 ? (
          <p className="rounded-xl border border-white/[0.06] px-3 py-4 text-center text-xs text-slate-500">
            Nothing here — every outbound message is in good shape.
          </p>
        ) : (
          visible.map((row) => {
            const status = (row.status as DeliveryStatus) ?? "pending";
            return (
              <div
                key={row.kind + "-" + row.id}
                className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm text-slate-200">
                    <span className="font-mono text-[11px] text-slate-400">
                      #{row.id}
                    </span>{" "}
                    {row.label || "message"}
                    {row.channel && row.channel !== "whatsapp" ? (
                      <span className="ml-1.5 text-[10px] text-slate-500">
                        {row.channel}
                      </span>
                    ) : null}
                  </p>
                  <span
                    className={
                      "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] " +
                      (STATUS_STYLES[status] ?? STATUS_STYLES.pending)
                    }
                  >
                    {STATUS_LABELS[status] ?? row.status}
                    {row.attempts > 0 ? ` · ${row.attempts}` : ""}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-[11px] text-slate-500">
                    {row.errorMessage
                      ? row.errorMessage
                      : status === "failed" && row.nextAttemptAt
                        ? "Retrying " + formatWhen(row.nextAttemptAt)
                        : formatWhen(row.updatedAt ?? row.createdAt)}
                    {row.providerMessageId
                      ? " · id " + row.providerMessageId
                      : ""}
                  </p>
                  {status === "dead" || status === "failed" ? (
                    <button
                      onClick={() => void replay(row.id)}
                      disabled={busy}
                      className="shrink-0 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-50"
                    >
                      Replay
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
