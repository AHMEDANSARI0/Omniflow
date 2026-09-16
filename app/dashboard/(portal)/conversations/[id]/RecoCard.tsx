"use client";

import { useCallback, useEffect, useState } from "react";

interface RecoSuggestion {
  name: string;
  priceText: string;
  notes: string;
  kind: string;
  score: number;
  reasons: string[];
}

interface RecoResult {
  contactName: string | null;
  suggestions: RecoSuggestion[];
}


export default function RecoCard({ conversationId }: { conversationId: number }) {
  const [recos, setRecos] = useState<RecoResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(conversationId) || conversationId <= 0) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/omniflow/portal/reco/surface?conversation_id=${conversationId}`,
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        setRecos(payload as unknown as RecoResult);
      }
    } catch {
      return;
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!recos || recos.suggestions.length === 0) return null;

  return (
    <section className="of-fade-up rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Recommendations</p>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Based on orders, chat mentions and what similar customers bought.
      </p>
      <ul className="mt-3 space-y-2">
        {recos.suggestions.map((suggestion) => (
          <li
            key={suggestion.name}
            className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-medium text-slate-200">
                {suggestion.name}
              </p>
              {suggestion.priceText ? (
                <span className="shrink-0 text-[10px] text-slate-500">
                  {suggestion.priceText}
                </span>
              ) : null}
            </div>
            {suggestion.notes ? (
              <p className="mt-0.5 truncate text-[11px] text-slate-500">
                {suggestion.notes}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-1">
              {suggestion.reasons.map((reason) => (
                <span
                  key={reason}
                  className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.08] px-1.5 py-0.5 text-[10px] text-cyan-300"
                >
                  {reason}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
