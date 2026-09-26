"use client";

import { useCallback, useEffect, useState } from "react";

interface OptOutRow {
  contactId: string;
  reason: string;
  createdAt: string | null;
}


export default function CompliancePage() {
  const [rows, setRows] = useState<OptOutRow[]>([]);
  const [query, setQuery] = useState("");
  const [contact, setContact] = useState("");
  const [reason, setReason] = useState("customer");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/compliance/optouts?q=" + encodeURIComponent(q),
        { cache: "no-store" }
      );
      if (!response.ok) {
        setFailed(true);
        setRows([]);
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      const raw =
        payload !== null && typeof payload === "object"
          ? (payload as Record<string, unknown>).optouts
          : null;
      setFailed(false);
      setRows(Array.isArray(raw) ? (raw as OptOutRow[]) : []);
    } catch {
      setFailed(true);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  async function addOptOut() {
    const trimmed = contact.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/compliance/optouts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact: trimmed, reason }),
        }
      );
      if (response.ok) {
        setContact("");
        setNote("Added to the opt-out list. They will not receive automated sends.");
        await load(query);
      } else {
        setNote("Could not add the contact. Check the number and try again.");
      }
    } catch {
      setNote("Could not add the contact. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function removeOptOut(row: OptOutRow) {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/compliance/optouts?contact=" +
          encodeURIComponent(row.contactId),
        { method: "DELETE" }
      );
      if (response.ok) {
        setNote("Removed. The contact can receive messages again.");
        await load(query);
      } else {
        setNote("Could not remove the contact. Try again shortly.");
      }
    } catch {
      setNote("Could not remove the contact. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl 2xl:max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Compliance
        </h1>
        <p className="mt-1 text-sm text-ink-3">
          Customers who asked to stop receiving messages. Automated sends to
          these contacts are blocked at the source.
        </p>
      </div>

      <section className="rounded-2xl border border-line bg-soft p-4">
        <p className="text-xs font-semibold text-ink">Add an opt-out</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            placeholder="923001234567"
            className="flex-1 rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder-slate-400 outline-none transition-colors focus:border-brand/40"
          />
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink outline-none focus:border-brand/40"
          >
            <option value="customer">Customer asked</option>
            <option value="merchant">Merchant decision</option>
          </select>
          <button
            onClick={() => void addOptOut()}
            disabled={busy || !contact.trim()}
            className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-sm font-medium text-brand transition-colors hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {note ? <p className="mt-2 text-xs text-ink-3">{note}</p> : null}
      </section>

      <section className="mt-4 rounded-2xl border border-line bg-soft p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs font-semibold text-ink">Opt-out list</p>
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search number"
              className="w-full rounded-xl border border-line bg-soft px-3 py-1.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors focus:border-brand/40 sm:w-48"
            />
            <button
              onClick={() => void load(query)}
              className="shrink-0 rounded-xl border border-line bg-soft px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-soft"
            >
              Search
            </button>
          </div>
        </div>

        {loading ? (
          <div className="mt-3 animate-pulse space-y-2">
            <div className="h-9 rounded-xl bg-soft" />
            <div className="h-9 rounded-xl bg-soft" />
          </div>
        ) : failed ? (
          <p className="mt-3 text-xs text-ink-3">
            The opt-out list is temporarily unavailable. Try again shortly.
          </p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-xs text-ink-3">
            {query
              ? "No opt-outs match this search."
              : "No opt-outs yet. When a customer sends STOP, they appear here automatically."}
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {rows.map((row) => (
              <li
                key={row.contactId}
                className="flex flex-col gap-2 rounded-xl border border-line bg-soft px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{row.contactId}</p>
                  <p className="text-[10px] uppercase tracking-wider text-ink-3">
                    {row.reason === "merchant" ? "Merchant decision" : "Customer asked"}
                  </p>
                </div>
                <button
                  onClick={() => void removeOptOut(row)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-line bg-soft px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
