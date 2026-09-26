"use client";

import { useCallback, useEffect, useState } from "react";
import ScheduleCard from "./ScheduleCard";

interface BroadcastPreview {
  audience: string;
  count: number;
  sample: string[];
}

interface BroadcastRow {
  id: number;
  audience: string;
  body: string;
  recipientCount: number;
  createdAt: string | null;
  queued: number | null;
  done: number | null;
  failed: number | null;
}

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";

const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";

function audienceLabel(audience: string): string {
  if (audience === "open") return "Open chats";
  if (audience === "hot") return "Hot leads";
  return "All customers";
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function BroadcastsClient({
  initialHistory,
}: {
  initialHistory?: BroadcastRow[] | null;
}) {
  const [history, setHistory] = useState<BroadcastRow[]>(initialHistory ?? []);
  const [loaded, setLoaded] = useState(initialHistory !== null);
  const [expired, setExpired] = useState(false);
  const [audience, setAudience] = useState("all");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        broadcasts?: BroadcastRow[];
      } | null;
      if (payload && Array.isArray(payload.broadcasts)) {
        setHistory(payload.broadcasts);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — the next refresh retries.
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    let alive = true;
    setPreviewLoading(true);
    setConfirming(false);
    async function loadPreview() {
      try {
        const response = await fetch(
          "/api/omniflow/portal/broadcasts/preview?audience=" + audience,
          { credentials: "same-origin", cache: "no-store" }
        );
        if (!response.ok || !alive) return;
        const payload = (await response.json().catch(() => null)) as BroadcastPreview | null;
        if (alive && payload) setPreview(payload);
      } catch {
        // The compose card simply shows no count until the preview lands.
      } finally {
        if (alive) setPreviewLoading(false);
      }
    }
    const timer = window.setTimeout(loadPreview, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [audience]);

  async function sendBroadcast() {
    if (busy || !body.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ audience, body: body.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        recipients?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text:
            "Broadcast queued for " +
            String(payload.recipients ?? 0) +
            " customers — messages go out as the connector sends them.",
        });
        setBody("");
        setConfirming(false);
        await loadHistory();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not send the broadcast. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-line bg-soft px-6 py-12 text-center">
          <p className="text-sm text-ink-2">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-brand transition-colors hover:text-brand"
          >
            Re-authenticate →
          </a>
        </div>
      </div>
    );
  }

  const overLimit = (preview?.count ?? 0) > 200;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Broadcasts
          </h1>
          <a
            href="/dashboard/broadcasts/calendar"
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-3 transition hover:text-ink"
          >
            Calendar
          </a>
        </div>
        <p className="mt-1 text-sm text-ink-3">
          Send one WhatsApp message to a targeted audience. Use{" "}
          <span className="rounded-md border border-line bg-soft px-1 py-0.5 text-xs text-brand">
            {"{name}"}
          </span>{" "}
          in the text and it becomes each customer&apos;s first name.
        </p>
      </div>

      <ScheduleCard />

      <div className="rounded-2xl border border-line bg-soft p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink outline-none transition-colors duration-300 focus:border-brand/40 sm:w-56"
          >
            <option value="all">All customers</option>
            <option value="open">Open chats</option>
            <option value="hot">Hot leads</option>
          </select>
          <p className="text-xs text-ink-3">
            {previewLoading
              ? "Counting customers…"
              : overLimit
                ? (preview?.count ?? 0) + " customers match — narrow the audience (max 200)."
                : "Reaches " + (preview?.count ?? 0) + " customers"}
            {!previewLoading && !overLimit && preview && preview.sample.length > 0 && (
              <span className="block truncate text-[11px] text-ink-3">
                e.g. {preview.sample.join(", ")}
              </span>
            )}
          </p>
        </div>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          maxLength={1000}
          placeholder={"Hi {name}! New winter collection is live — 20% off this week only."}
          className={inputClass + " mt-3 resize-none"}
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {confirming ? (
            <>
              <span className="text-xs text-amber-600">
                Send to {preview?.count ?? 0} customers on WhatsApp?
              </span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="w-full rounded-xl border border-line bg-soft px-4 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:bg-soft disabled:opacity-50 sm:w-auto"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={sendBroadcast}
                disabled={busy || overLimit || !body.trim()}
                className="w-full rounded-xl border border-emerald-400/25 bg-emerald-400/[0.08] px-4 py-2 text-xs font-medium text-ok transition-colors duration-300 hover:bg-emerald-400/[0.14] disabled:opacity-50 sm:w-auto"
              >
                {busy ? "Sending…" : "Confirm send"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
                setMessage(null);
              }}
              disabled={!body.trim() || overLimit || (preview?.count ?? 0) === 0}
              className={primaryBtn + " w-full sm:w-auto"}
            >
              Send broadcast
            </button>
          )}
        </div>
        {message && (
          <p
            className={
              "mt-3 text-xs " +
              (message.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {message.text}
          </p>
        )}
      </div>

      <div className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-3">
          Recent broadcasts
        </h2>
        {loaded && history.length === 0 ? (
          <p className="mt-3 text-xs text-ink-3">
            No broadcasts yet — the first one goes out above.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {history.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-line bg-soft p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand/70">
                      {audienceLabel(row.audience)}
                    </span>
                    <span className="text-[10px] text-ink-3">
                      {formatWhen(row.createdAt)}
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-3">
                    {row.recipientCount} recipients
                    {typeof row.done === "number" && row.done > 0
                      ? " · " + String(row.done) + " sent"
                      : ""}
                    {typeof row.failed === "number" && row.failed > 0
                      ? " · " + String(row.failed) + " failed"
                      : ""}
                  </p>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-ink-2">
                  {row.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
