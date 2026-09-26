"use client";

import { useCallback, useEffect, useState } from "react";

interface AssistSentiment {
  label: string;
  score: number;
  engine: "llm" | "lexicon";
  positive: string[];
  negative: string[];
}

interface KbSuggestion {
  id: number;
  question: string;
  snippet: string;
  matched: string[];
}

interface AssistResult {
  intent: string;
  sentiment: AssistSentiment | null;
  language: string | null;
  linked: string[];
  suggestions: KbSuggestion[];
  basedOn: string;
}


interface BrainDraft {
  decision: string;
  draft: string;
  kbEntry?: { title: string; content: string } | null;
}

export default function AssistCard({ conversationId }: { conversationId: number }) {
  const [assist, setAssist] = useState<AssistResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<BrainDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNote, setDraftNote] = useState<{ text: string; ok: boolean } | null>(
    null
  );

  const load = useCallback(async () => {
    if (!Number.isFinite(conversationId) || conversationId <= 0) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${conversationId}/assist`,
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        setAssist(payload as unknown as AssistResult);
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

  async function makeDraft() {
    if (draftBusy) return;
    setDraftBusy(true);
    setDraftNote(null);
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${conversationId}/draft`,
        { method: "POST", headers: { "Content-Type": "application/json" } }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        draft?: BrainDraft;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok && payload.draft) {
        setDraft(payload.draft);
        setDraftNote(null);
      } else {
        setDraftNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not draft right now.",
          ok: false,
        });
      }
    } catch {
      setDraftNote({ text: "Could not draft right now.", ok: false });
    } finally {
      setDraftBusy(false);
    }
  }

  async function saveDraftToKb() {
    if (!draft?.kbEntry) return;
    setDraftBusy(true);
    setDraftNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: {
            title: draft.kbEntry.title,
            content: draft.kbEntry.content,
            isActive: true,
            lang: "auto",
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setDraftNote({ text: "Saved to the knowledge base.", ok: true });
        setDraft((prev) => (prev ? { ...prev, kbEntry: null } : prev));
      } else {
        setDraftNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not save — try again.",
          ok: false,
        });
      }
    } catch {
      setDraftNote({ text: "Could not save — try again.", ok: false });
    } finally {
      setDraftBusy(false);
    }
  }

  if (!assist) return null;
  const sentiment = assist.sentiment?.label ?? null;
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
        {sentiment && sentiment !== "neutral" ? (
          <span
            className={`rounded-md border px-1.5 py-0.5 ${
              sentiment === "negative"
                ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                : sentiment === "mixed"
                  ? "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
                  : "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
            }`}
          >
            Sentiment: {sentiment}
            {assist.sentiment?.engine === "llm" ? " · AI" : ""}
          </span>
        ) : null}
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

      {assist.sentiment && assist.sentiment.negative.length > 0 ? (
        <p className="mt-2 text-[11px] text-amber-300/80">
          Flagged: {assist.sentiment.negative.join(", ")}
        </p>
      ) : null}

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

      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => void makeDraft()}
            disabled={draftBusy}
            className="rounded-xl border border-violet-400/30 bg-violet-400/[0.08] px-3 py-1.5 text-[11px] font-medium text-violet-200 transition-colors hover:bg-violet-400/[0.14] disabled:opacity-50"
          >
            {draftBusy ? "Working…" : "Draft with AI"}
          </button>
          {draftNote ? (
            <span
              className={
                "text-[11px] " +
                (draftNote.ok ? "text-emerald-300" : "text-rose-300")
              }
            >
              {draftNote.text}
            </span>
          ) : null}
        </div>
        {draft ? (
          <div className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              {draft.decision} draft
            </p>
            <p className="mt-1 whitespace-pre-wrap text-xs text-slate-200">
              {draft.draft}
            </p>
            {draft.kbEntry ? (
              <button
                onClick={() => void saveDraftToKb()}
                disabled={draftBusy}
                className="mt-2 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.08] px-2.5 py-1 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-400/[0.14] disabled:opacity-50"
              >
                Save as KB answer
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
