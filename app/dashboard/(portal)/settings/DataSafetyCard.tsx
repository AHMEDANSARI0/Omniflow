"use client";

import { useEffect, useState } from "react";

export default function DataSafetyCard() {
  const [closeIdle, setCloseIdle] = useState(14);
  const [purgeRejected, setPurgeRejected] = useState(30);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/omniflow/portal/data/retention", { cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (!active || payload === null || !payload.retention) return;
        setCloseIdle(payload.retention.close_idle_days ?? 14);
        setPurgeRejected(payload.retention.purge_rejected_days ?? 30);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/data/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_idle_days: closeIdle,
          purge_rejected_days: purgeRejected,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not save.");
        return;
      }
      setNote(
        payload && payload.retention
          ? "Saved - close " + payload.retention.close_idle_days
            + "d, purge " + payload.retention.purge_rejected_days + "d."
          : "Saved."
      );
    } catch {
      setNote("Could not save - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/data/retention/run",
        { method: "POST" }
      );
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not run.");
        return;
      }
      setNote(
        payload && typeof payload.closed === "number"
          ? "Done - closed " + payload.closed + ", purged "
            + payload.purged + "."
          : "Done."
      );
    } catch {
      setNote("Could not run - try again.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    window.location.href = "/api/omniflow/portal/data/export";
  }

  const inputClass =
    "mt-1 w-24 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none";

  return (
    <section className="mt-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
      <h2 className="text-sm font-medium text-slate-200">Data &amp; backup</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Download everything (contacts, conversations, orders, returns) as one
        JSON file, and set how long idle chats and rejected requests stick
        around.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="text-[11px] text-slate-400">
            Close idle chats after (days)
          </span>
          <input
            type="number"
            min={1}
            max={90}
            value={closeIdle}
            onChange={(event) => setCloseIdle(Number(event.target.value))}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-400">
            Purge rejected requests after (days)
          </span>
          <input
            type="number"
            min={1}
            max={90}
            value={purgeRejected}
            onChange={(event) => setPurgeRejected(Number(event.target.value))}
            className={inputClass}
          />
        </label>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.08] px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/[0.15] disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save retention"}
        </button>
        <button
          onClick={() => void runNow()}
          disabled={busy}
          className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.06] disabled:opacity-50"
        >
          Run cleanup now
        </button>
        <button
          onClick={download}
          className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/[0.15]"
        >
          Download backup (JSON)
        </button>
      </div>
      {note ? <p className="mt-2 text-[11px] text-slate-400">{note}</p> : null}
    </section>
  );
}
