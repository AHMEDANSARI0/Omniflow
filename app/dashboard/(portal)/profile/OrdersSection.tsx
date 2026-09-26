"use client";

import { useCallback, useEffect, useState } from "react";
import type { OrderRow } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";

const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";

const chipClass =
  "rounded-md border border-line bg-soft px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-3";

interface ParsedOrder {
  code: string;
  status: string;
  note: string;
}

function parseOrdersText(text: string): ParsedOrder[] {
  const items: ParsedOrder[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    const code = (parts[0] || "").trim();
    if (!code) continue;
    items.push({
      code,
      status: (parts[1] || "").trim() || "pending",
      note: parts.slice(2).join(",").trim(),
    });
  }
  return items.slice(0, 500);
}

export default function OrdersSection() {
  const [items, setItems] = useState<OrderRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/orders", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        items?: OrderRow[];
      } | null;
      if (payload && Array.isArray(payload.items)) setItems(payload.items);
    } catch {
      // Transient network issue — the next action retries.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function importOrders() {
    if (busy) return;
    const parsed = parseOrdersText(draft);
    if (parsed.length === 0) {
      setMessage({
        kind: "error",
        text: "Add at least one line: code, status, note (status and note are optional).",
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: parsed }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        imported?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: String(payload.imported ?? parsed.length) +
            " orders imported — customers can now ask for their order status.",
        });
        setDraft("");
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not import. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeOrder(orderId: number) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/orders/" + String(orderId),
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setMessage({ kind: "ok", text: "Order removed." });
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: "Could not remove. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-soft p-6">
      <h2 className="text-sm font-semibold text-ink">Order tracking</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        Paste your orders — when a customer asks about their order on
        WhatsApp and mentions the order code, the assistant answers with the
        status instantly, day and night.
      </p>

      <textarea
        rows={5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={"10234, shipped, TCS 4456678\n10235, pending\n10236, delivered"}
        className={inputClass + " mt-4 resize-none font-mono text-xs"}
      />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => importOrders()}
          disabled={busy}
          className={primaryBtn + " w-full sm:w-auto"}
        >
          {busy ? "Importing..." : "Import / update orders"}
        </button>
        <p className="text-[11px] leading-relaxed text-ink-3">
          One order per line: code, status, note. Re-importing the same code
          updates it.
        </p>
      </div>

      {message && (
        <div
          className={
            "mt-4 rounded-xl border px-4 py-3 text-xs leading-relaxed " +
            (message.kind === "ok"
              ? "border-emerald-400/20 bg-emerald-400/[0.05] text-ok/90"
              : "border-red-400/20 bg-red-400/[0.05] text-red-200/90")
          }
        >
          {message.text}
        </div>
      )}

      {!loaded ? (
        <p className="mt-4 text-xs text-ink-3">Loading orders...</p>
      ) : items.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          No orders yet — paste your list above to enable instant order
          status replies.
        </p>
      ) : (
        <div className="mt-5 space-y-2.5">
          {items.map((order) => (
            <div
              key={order.id}
              className="flex flex-col gap-2 rounded-xl border border-line bg-white/[0.01] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-xs font-semibold text-ink">
                    {order.code}
                  </p>
                  <span className={chipClass}>{order.statusText}</span>
                </div>
                {order.note && (
                  <p className="mt-1 truncate text-[11px] text-ink-3">
                    {order.note}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeOrder(order.id)}
                disabled={busy}
                className="w-full shrink-0 rounded-xl border border-red-400/15 bg-red-400/[0.04] px-4 py-2 text-xs font-medium text-danger/80 transition-colors duration-300 hover:bg-red-400/[0.09] disabled:opacity-50 sm:w-auto"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
