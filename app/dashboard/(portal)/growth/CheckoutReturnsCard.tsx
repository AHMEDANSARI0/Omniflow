"use client";

import { useCallback, useEffect, useState } from "react";

interface ReturnRow {
  id: number;
  linkId: number;
  reason: string;
  note: string;
  title: string;
  total: number;
  createdAt: string | null;
}

const REASON_LABELS: Record<string, string> = {
  size: "Size",
  fit: "Fit",
  damaged: "Damaged",
  late: "Late delivery",
  changed_mind: "Changed mind",
  other: "Other",
};

  async function exportCsv() {
    try {
      const response = await fetch("/api/omniflow/portal/checkout/returns/export", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "omniflow-returns.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      return;
    }
  }

export default function CheckoutReturnsCard() {
  const [items, setItems] = useState<ReturnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/checkout/returns", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        returns?: ReturnRow[];
        counts?: { total?: number };
      } | null;
      if (!payload || !Array.isArray(payload.returns)) return;
      setItems(payload.returns);
      setTotal(
        typeof payload.counts?.total === "number" ? payload.counts.total : 0
      );
      setVisible(true);
    } catch {
      return;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loaded && !visible) return null;

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Returns</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Orders marked returned, newest first. Returned orders drop out of
            revenue and VIP counts automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void exportCsv()}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.06]"
          >
            Export CSV
          </button>
          <span className="rounded-md border border-rose-400/25 bg-rose-400/[0.08] px-2 py-0.5 text-[11px] text-rose-300">
            {total} total
          </span>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-4 text-xs text-slate-500">
          No returns yet. Mark a paid or delivered order as returned and it
          shows up here with the reason.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-white/[0.05]">
          {items.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-200">
                  {row.title || "Order #" + row.linkId} · {row.total}
                </p>
                <p className="truncate text-[10px] text-slate-500">
                  {row.note ? row.note + " · " : ""}
                  {row.createdAt
                    ? new Date(row.createdAt).toLocaleDateString()
                    : ""}
                </p>
              </div>
              <span className="shrink-0 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[10px] text-amber-300">
                {REASON_LABELS[row.reason] || row.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
