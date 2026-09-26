"use client";

import { useCallback, useEffect, useState } from "react";
import RiskCard from "./RiskCard";
import AddressCard from "./AddressCard";

interface Settings {
  enabled: boolean;
  template: string;
}

interface CodRow {
  id: number;
  conversationId: number | null;
  contactName: string | null;
  contactId: string;
  status: "pending" | "confirmed" | "declined";
  createdAt: string;
  answeredAt: string | null;
}

const FILTERS = ["all", "pending", "confirmed", "declined"] as const;

const STATUS_STYLES: Record<string, string> = {
  pending: "border-amber-400/25 bg-amber-400/[0.07] text-amber-600",
  confirmed: "border-emerald-400/25 bg-emerald-400/[0.07] text-ok",
  declined: "border-rose-400/25 bg-rose-400/[0.07] text-danger",
};

function formatWhen(value: string): string {
  if (!value) return "\u2014";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export default function CodPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [template, setTemplate] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [requests, setRequests] = useState<CodRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loadError, setLoadError] = useState(false);

  const loadRequests = useCallback(async (which: string) => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/cod/requests?status=" + which,
        { cache: "no-store" }
      );
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const p = payload as { requests?: unknown; counts?: unknown };
        setRequests(Array.isArray(p.requests) ? (p.requests as CodRow[]) : []);
        setCounts(
          p.counts !== null && typeof p.counts === "object"
            ? (p.counts as Record<string, number>)
            : {}
        );
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/omniflow/portal/cod", {
          cache: "no-store",
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!cancelled && payload !== null && typeof payload === "object") {
          const raw = (payload as { settings?: Settings }).settings;
          if (raw) {
            setSettings(raw);
            setEnabled(raw.enabled);
            setTemplate(raw.template);
          } else {
            setLoadError(true);
          }
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadRequests(filter);
  }, [filter, loadRequests]);

  const save = useCallback(async () => {
    if (!template.trim()) {
      setNote("Write the confirmation message first.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/cod", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, template }),
      });
      if (response.ok) {
        setNote(enabled ? "Saved. COD confirmations are ON." : "Saved. COD confirmations are off.");
      } else {
        setNote("Could not save. Check the message length (1000 max).");
      }
    } catch {
      setNote("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }, [enabled, template]);

  const chipCount = (key: string) => (typeof counts[key] === "number" ? counts[key] : 0);

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-brand/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">COD confirmations</h1>
          <p className="mt-1.5 text-sm text-ink-3">
            Hot leads get one confirmation ask automatically; their YES or NO reply is
            recorded here so delivered orders (and returns) stay visible.
          </p>
        </div>

        <RiskCard />
        <AddressCard />

        {loadError ? (
          <p className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-600">
            COD confirmations are unavailable right now.
          </p>
        ) : null}

        <div className="mb-6 rounded-2xl border border-line bg-soft p-4 sm:p-5">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium text-ink">Ask for confirmation</span>
              <span className="mt-0.5 block text-xs text-ink-3">
                Sends once per customer per 24 hours, only when a chat is marked as a hot lead.
              </span>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-5 w-5 shrink-0 accent-cyan-400"
            />
          </label>

          <textarea
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            rows={3}
            maxLength={1000}
            className="mt-3 w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
            placeholder={"Use {name} and it becomes each customer's first name."}
          />
          <p className="mt-1 text-[11px] text-ink-3">
            Customer replies YES or NO (English or Roman Urdu both work).
          </p>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || loading}
              className="rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-medium text-brand transition hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {busy ? "Saving\u2026" : "Save settings"}
            </button>
            {note ? <p className="text-xs text-ink-3">{note}</p> : null}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1 rounded-full border border-line bg-soft p-1">
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={
                "rounded-full px-3 py-1 text-xs font-medium capitalize transition " +
                (filter === option
                  ? "bg-cyan-400/15 text-brand"
                  : "text-ink-3 hover:text-ink")
              }
            >
              {option} ({option === "all" ? requests.length : chipCount(option)})
            </button>
          ))}
        </div>

        {requests.length === 0 ? (
          <div className="rounded-2xl border border-line bg-soft px-5 py-8 text-center">
            <p className="text-sm text-ink-3">No COD requests in this view yet.</p>
            <p className="mt-1 text-xs text-ink-3">
              Turn the ask on above; hot leads will be asked on their next message.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {requests.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-2xl border border-line bg-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">
                    {row.contactName || row.contactId}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    Asked {formatWhen(row.createdAt)}
                    {row.answeredAt ? " \u00b7 replied " + formatWhen(row.answeredAt) : ""}
                  </p>
                </div>
                <span
                  className={
                    "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize " +
                    (STATUS_STYLES[row.status] ?? STATUS_STYLES.pending)
                  }
                >
                  {row.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
