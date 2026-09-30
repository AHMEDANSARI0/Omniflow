"use client";

import { useCallback, useEffect, useState } from "react";

interface VoiceNumber {
  client_id: number;
  number: string;
  enabled: boolean;
}

const INPUT =
  "w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none";

/** Admin: the dialled Twilio number decides which workspace's phone
 * assistant answers. One number answers for one workspace. */
export default function VoiceNumbersPanel() {
  const [numbers, setNumbers] = useState<VoiceNumber[] | null>(null);
  const [clientId, setClientId] = useState("");
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/admin/voice/numbers", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as {
        numbers?: VoiceNumber[];
      } | null;
      setNumbers(response.ok && payload?.numbers ? payload.numbers : []);
    } catch {
      setNumbers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function assign(targetClient: number, targetNumber: string) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/admin/voice/numbers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: targetClient, number: targetNumber }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setNotice({
          text: targetNumber
            ? "Number assigned to workspace " + targetClient + "."
            : "Number removed from workspace " + targetClient + ".",
          ok: true,
        });
        setClientId("");
        setNumber("");
        await load();
      } else {
        setNotice({
          text: payload?.error?.message || "Could not save. Try again.",
          ok: false,
        });
      }
    } catch {
      setNotice({ text: "Could not save. Try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-white shadow-card p-6">
      <h2 className="text-sm font-semibold text-ink">Phone numbers</h2>
      <p className="mb-5 mt-1 text-xs text-ink-3">
        Assign each Twilio number to the workspace whose phone assistant should
        answer it. Calls to unassigned numbers go to voicemail. The workspace
        turns its assistant on under Settings &gt; Voice and images.
      </p>
      {numbers === null ? (
        <p className="text-xs text-ink-3">Loading…</p>
      ) : numbers.length === 0 ? (
        <p className="text-xs text-ink-3">No numbers assigned yet.</p>
      ) : (
        <ul className="space-y-2">
          {numbers.map((row) => (
            <li
              key={row.client_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-soft px-3 py-2 text-xs"
            >
              <span className="text-ink">
                {row.number}
                <span className="ml-2 text-ink-3">workspace {row.client_id}</span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className={
                    "rounded-md border px-2 py-0.5 text-[10px] " +
                    (row.enabled
                      ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                      : "border-line bg-white text-ink-3")
                  }
                >
                  {row.enabled ? "Assistant on" : "Assistant off"}
                </span>
                <button
                  onClick={() => void assign(row.client_id, "")}
                  disabled={busy}
                  className="text-[11px] text-danger disabled:opacity-50"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <input
          value={clientId}
          onChange={(event) => setClientId(event.target.value.replace(/\D/g, ""))}
          placeholder="Workspace id"
          inputMode="numeric"
          className={INPUT}
        />
        <input
          value={number}
          onChange={(event) => setNumber(event.target.value.trim())}
          placeholder="+14155550100"
          autoComplete="off"
          className={INPUT}
        />
        <button
          onClick={() => void assign(Number(clientId), number)}
          disabled={busy || !clientId || !number}
          className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors disabled:opacity-50"
        >
          {busy ? "Saving…" : "Assign"}
        </button>
      </div>
      {notice ? (
        <p className={"mt-3 text-[11px] " + (notice.ok ? "text-ok" : "text-danger")}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
