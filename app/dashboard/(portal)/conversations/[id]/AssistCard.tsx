"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getConversationAssist,
  requirePortalAccessToken,
  type AssistResult,
} from "../../../../../lib/omniflow/portal";


export default function AssistCard({ conversationId }: { conversationId: number }) {
  const [assist, setAssist] = useState<AssistResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(conversationId) || conversationId <= 0) return;
    setBusy(true);
    try {
      const accessToken = await requirePortalAccessToken();
      if (!accessToken) return;
      const result = await getConversationAssist(accessToken, conversationId);
      if (result !== null) setAssist(result);
    } catch {
      return;
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!assist) return null;
  const empty =
    assist.suggestions.length === 0 &&
    assist.intent === "other" &&
    assist.linked.length === 0 &&
    !assist.language;
  if (empty) return null;

  return (
    <section className="of-fade-up rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Agent assist</p>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.08] px-1.5 py-0.5 text-cyan-300">
          Intent: {assist.intent}
        </span>
        {assist.language ? (
          <span className="rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-violet-300">
            Language: {assist.language}
          </span>
        ) : null}
        {assist.linked.map((linked) => (
          <span
            key={linked}
            className="rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-slate-400"
          >
            Linked: {linked}
          </span>
        ))}
      </div>

      {assist.suggestions.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {assist.suggestions.map((suggestion) => (
            <li
              key={suggestion.id}
              className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
            >
              <p className="text-xs font-medium text-slate-200">
                {suggestion.question}
              </p>
              <p className="mt-1 text-xs text-slate-400">{suggestion.snippet}</p>
              {suggestion.matched.length > 0 ? (
                <p className="mt-1 text-[10px] text-slate-600">
                  Matched: {suggestion.matched.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          No knowledge-base matches for the latest messages.
        </p>
      )}
    </section>
  );
}
