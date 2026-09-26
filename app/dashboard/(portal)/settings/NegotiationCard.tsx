"use client";

import { useCallback, useEffect, useState } from "react";

interface NegotiationDecision {
  decision: "accept" | "counter" | "reject";
  counter_price: number;
  floor: number;
  message: string;
}

/**
 * Settings -> Negotiation: the owner's hard bounds (min price, max
 * discount %) plus a quick calculator. The floor is always computed by
 * the Control Plane - the AI only phrases the reply, never re-prices.
 */
export default function NegotiationCard() {
  const [enabled, setEnabled] = useState(false);
  const [minPrice, setMinPrice] = useState("0");
  const [maxPct, setMaxPct] = useState("10");
  const [price, setPrice] = useState("");
  const [offer, setOffer] = useState("");
  const [result, setResult] = useState<NegotiationDecision | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/negotiation/bounds",
        { cache: "no-store" }
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          settings?: {
            enabled: boolean;
            min_price: number;
            max_discount_pct: number;
          };
        };
        if (payload.settings) {
          setEnabled(payload.settings.enabled);
          setMinPrice(String(payload.settings.min_price));
          setMaxPct(String(payload.settings.max_discount_pct));
        }
      }
    } catch {
      /* keep defaults */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBounds(nextEnabled: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/negotiation/bounds",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: nextEnabled,
            min_price: Number(minPrice) || 0,
            max_discount_pct: Number(maxPct) || 0,
          }),
        }
      );
      if (response.ok) {
        setEnabled(nextEnabled);
        setNote("Saved.");
      } else {
        setNote("Could not save - check the values.");
      }
    } catch {
      setNote("Could not save. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function decide() {
    const p = Number(price);
    const o = Number(offer);
    if (!p || !o) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/omniflow/portal/negotiation/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price: p, offer: o }),
      });
      if (response.ok) {
        setResult((await response.json()) as NegotiationDecision);
      } else {
        setNote("Decide failed - is negotiation enabled?");
      }
    } catch {
      setNote("Decide failed. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-line bg-soft p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Negotiation bounds
          </h3>
          <p className="mt-0.5 text-xs text-ink-3">
            The floor is computed from these numbers - the assistant can
            never cross it, only word the offer.
          </p>
        </div>
        <button
          onClick={() => void saveBounds(!enabled)}
          disabled={busy}
          className={
            "rounded-full border px-3 py-1 text-[11px] " +
            (enabled
              ? "border-emerald-400/40 bg-emerald-400/[0.12] text-ok"
              : "border-line bg-soft text-ink-3")
          }
        >
          {enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11px] text-ink-3">Min price (RS)</span>
          <input
            value={minPrice}
            onChange={(event) => setMinPrice(event.target.value)}
            inputMode="decimal"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-3">Max discount (%)</span>
          <input
            value={maxPct}
            onChange={(event) => setMaxPct(event.target.value)}
            inputMode="decimal"
            className="mt-1 w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none"
          />
        </label>
      </div>
      <button
        onClick={() => void saveBounds(enabled)}
        disabled={busy}
        className="mt-2 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-soft disabled:opacity-50"
      >
        Save bounds
      </button>

      <div className="mt-4 border-t border-line pt-3">
        <p className="text-[11px] font-semibold text-ink-2">
          Quick check
        </p>
        <div className="mt-1.5 flex gap-2">
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="asking price"
            inputMode="decimal"
            className="min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
          />
          <input
            value={offer}
            onChange={(event) => setOffer(event.target.value)}
            placeholder="customer offer"
            inputMode="decimal"
            className="min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
          />
          <button
            onClick={() => void decide()}
            disabled={busy || !price || !offer}
            className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-40"
          >
            Decide
          </button>
        </div>
        {result ? (
          <div className="mt-2 rounded-xl border border-line bg-soft px-3 py-2">
            <p className="text-xs text-ink">
              <span
                className={
                  result.decision === "accept"
                    ? "text-ok"
                    : result.decision === "counter"
                      ? "text-amber-600"
                      : "text-danger"
                }
              >
                {result.decision.toUpperCase()}
              </span>
              {" \u00b7 floor " + result.floor}
            </p>
            <p className="mt-1 text-[11px] text-ink-3">
              {result.message}
            </p>
          </div>
        ) : null}
      </div>
      {note ? <p className="mt-2 text-[11px] text-ink-3">{note}</p> : null}
    </section>
  );
}
