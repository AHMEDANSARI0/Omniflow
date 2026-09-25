"use client";

import { useCallback, useEffect, useState } from "react";

interface CsatState {
  score: number | null;
  requestedAt: string | null;
  answeredAt: string | null;
}

export default function RatingCard({ conversationId }: { conversationId: number }) {
  const [csat, setCsat] = useState<CsatState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/csat",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        csat?: CsatState | null;
      } | null;
      if (payload) {
        setCsat(payload.csat ?? null);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — reopening the thread retries.
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendRequest() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/csat",
        {
          method: "POST",
          credentials: "same-origin",
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Rating request sent on WhatsApp." });
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not send. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (loaded && csat === null) {
    return (
      <div className="mb-4 rounded-2xl border border-line bg-soft p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-ink">Customer rating</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
              Ask the customer to rate this chat from 1 to 5 — the reply is
              recorded automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={sendRequest}
            disabled={busy}
            className="w-full shrink-0 rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Sending…" : "Ask for rating"}
          </button>
        </div>
        {message && (
          <p
            className={
              "mt-2 text-[11px] " +
              (message.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {message.text}
          </p>
        )}
      </div>
    );
  }

  if (!loaded && csat === null) return null;

  const answered = csat?.answeredAt && csat.score !== null;

  return (
    <div
      className={
        "mb-4 rounded-2xl border p-4 " +
        (answered
          ? "border-emerald-400/20 bg-emerald-400/[0.05]"
          : "border-amber-400/20 bg-amber-400/[0.05]")
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-ink">Customer rating</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
            {answered
              ? "Customer rated this chat " + String(csat?.score) + "/5."
              : "Waiting for the customer's 1–5 reply (valid 48 hours)."}
          </p>
        </div>
        <button
          type="button"
          onClick={sendRequest}
          disabled={busy}
          className="w-full shrink-0 rounded-xl border border-line bg-soft px-4 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:bg-soft disabled:opacity-50 sm:w-auto"
        >
          {busy ? "Sending…" : "Ask again"}
        </button>
      </div>
      {message && (
        <p
          className={
            "mt-2 text-[11px] " +
            (message.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
