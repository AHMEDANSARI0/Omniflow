"use client";

import { useCallback, useEffect, useState } from "react";

interface SequenceOption {
  id: number;
  name: string;
  enabled: boolean;
}

export default function AddToSequenceCard({ contactId }: { contactId: string | null }) {
  const [options, setOptions] = useState<SequenceOption[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState("neutral");

  useEffect(() => {
    if (!contactId) return;
    let alive = true;
    fetch("/api/omniflow/portal/sequences", { cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (!alive) return;
        const list =
          payload !== null && typeof payload === "object"
            ? (payload as { sequences?: SequenceOption[] }).sequences
            : null;
        const enabled = (Array.isArray(list) ? list : []).filter(
          (row) => row && row.enabled === true
        );
        setOptions(enabled);
        setPicked(enabled.length > 0 ? enabled[0].id : null);
      })
      .catch(() => {
        if (alive) setOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [contactId]);

  const enroll = useCallback(async () => {
    if (busy || !contactId || picked === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/sequences/" + String(picked) + "/enrollments",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The endpoint takes bare jids and pulls the display name from the
          // conversation row itself (contact_name rides the join).
          body: JSON.stringify({ contacts: [contactId] }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        enrolled?: number;
        skipped?: string[];
      } | null;
      if (response.ok && payload && typeof payload.enrolled === "number") {
        const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
        setTone("emerald");
        setMessage(
          skipped > 0
            ? "Already in a series \u2014 no duplicate added."
            : "Added. Step 1 lands per the series' first delay."
        );
      } else if (response.status === 400) {
        setTone("amber");
        setMessage("Could not add \u2014 is the series turned on?");
      } else {
        setTone("amber");
        setMessage("Could not add. Try again.");
      }
    } catch {
      setTone("amber");
      setMessage("Could not add. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, contactId, picked]);

  if (!contactId || options === null || options.length === 0) return null;

  return (
    <div className="rounded-2xl border border-line bg-soft p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-ink">Add to series</h2>
      </div>
      <p className="mt-1 text-[11px] text-ink-3">
        Start one of your enabled series for this customer right from the chat.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={picked ?? ""}
          onChange={(event) => setPicked(Number(event.target.value) || null)}
          className="w-full rounded-lg border border-line bg-soft px-2.5 py-2 text-xs text-ink outline-none focus:border-brand/40 sm:w-auto sm:flex-1"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id} className="bg-soft">
              {option.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void enroll()}
          disabled={busy || picked === null}
          className="shrink-0 rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-xs font-medium text-brand transition hover:bg-brand-soft disabled:opacity-50"
        >
          {busy ? "Adding..." : "Add"}
        </button>
      </div>
      {message ? (
        <p
          className={
            "mt-2 text-[11px] " +
            (tone === "emerald" ? "text-ok" : "text-amber-600")
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
