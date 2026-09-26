"use client";

import { useCallback, useEffect, useState } from "react";

interface CodState {
  status: string;
  details: string;
  createdAt: string | null;
  answeredAt: string | null;
}

const POLL_MS = 15_000;

export default function CodCard({ conversationId }: { conversationId: number }) {
  const [cod, setCod] = useState<CodState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/cod",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        cod?: CodState | null;
      } | null;
      if (payload) {
        setCod(payload.cod ?? null);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function sendRequest() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/cod",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ details: details.trim() }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Confirmation request sent on WhatsApp." });
        setExpanded(false);
        setDetails("");
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

  if (loaded && cod === null && !expanded) {
    return (
      <div className="mb-4 rounded-2xl border border-line bg-soft p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-ink">COD order</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
              Send a confirmation request — the customer replies YES or NO and
              OmniFlow tracks it automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setExpanded(true);
              setMessage(null);
            }}
            className="w-full shrink-0 rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft sm:w-auto"
          >
            Send COD confirmation
          </button>
        </div>
      </div>
    );
  }

  if (!loaded && cod === null && !expanded) return null;

  const banner =
    cod?.status === "pending"
      ? "border-amber-400/20 bg-amber-400/[0.05]"
      : cod?.status === "confirmed"
        ? "border-emerald-400/20 bg-emerald-400/[0.05]"
        : cod?.status === "cancelled"
          ? "border-red-400/20 bg-red-400/[0.05]"
          : "border-line bg-soft";
  const bannerText =
    cod?.status === "pending"
      ? "Awaiting customer confirmation — the customer can reply YES or NO on WhatsApp."
      : cod?.status === "confirmed"
        ? "COD confirmed — the customer replied YES."
        : cod?.status === "cancelled"
          ? "COD cancelled — the customer replied NO."
          : "COD request closed.";
  const bannerLabel =
    cod?.status === "pending"
      ? "COD pending"
      : cod?.status === "confirmed"
        ? "COD confirmed"
        : cod?.status === "cancelled"
          ? "COD cancelled"
          : "COD";

  return (
    <div className={"mb-4 rounded-2xl border p-4 " + banner}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink">{bannerLabel}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
            {bannerText}
          </p>
          {cod?.details && (
            <p className="mt-1 truncate text-[11px] text-ink-3">
              Order: {cod.details}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => sendRequest()}
          disabled={busy}
          className="w-full shrink-0 rounded-xl border border-line-2 bg-soft px-4 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:bg-white/[0.06] disabled:opacity-50 sm:w-auto"
        >
          {busy ? "Sending..." : "Send again"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={200}
            placeholder="Optional details, e.g. 2 suits, PKR 4,500"
            className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setDetails("");
              }}
              className="flex-1 rounded-xl border border-line bg-soft px-4 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:bg-soft sm:flex-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => sendRequest()}
              disabled={busy}
              className="flex-1 rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50 sm:flex-none"
            >
              {busy ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={
            "mt-2 text-[11px] " +
            (message.kind === "ok" ? "text-ok/90" : "text-danger/90")
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
