"use client";

import { useCallback, useEffect, useState } from "react";

interface WinbackEntry {
  contactId: string;
  name: string;
  kind: string;
  days: number | null;
  item: string;
  priceText: string;
  total: number | null;
  message: string;
  waLink: string | null;
}

interface WinbackData {
  cart: WinbackEntry[];
  reorder: WinbackEntry[];
  winback: WinbackEntry[];
  counts: Record<string, number>;
  scored: number;
}

const EMPTY: WinbackData = {
  cart: [],
  reorder: [],
  winback: [],
  counts: {},
  scored: 0,
};

function EntryCard({ entry }: { entry: WinbackEntry }) {
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(entry.message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  async function sendNow() {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/winback/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: entry.contactId, kind: entry.kind }),
      });
      if (response.ok) {
        setSent(true);
      } else if (response.status === 409) {
        setNote("Recently sent or no longer in the queue.");
      } else if (response.status === 404) {
        setNote("Contact no longer exists.");
      } else {
        setNote("Send failed - try again shortly.");
      }
    } catch {
      setNote("Send failed - try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  const chip =
    entry.kind === "cart"
      ? (entry.days ?? 0) + "d open"
      : entry.kind === "reorder"
        ? (entry.days ?? 0) + "d overdue"
        : "quiet " + (entry.days ?? 0) + "d";

  return (
    <li className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-slate-200">
          {entry.name || entry.contactId}
        </p>
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${
            entry.kind === "cart"
              ? "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
              : entry.kind === "reorder"
                ? "border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-300"
                : "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
          }`}
        >
          {chip}
        </span>
      </div>
      {entry.item || entry.total !== null ? (
        <p className="mt-0.5 truncate text-[11px] text-slate-500">
          {entry.item}
          {entry.priceText ? " · " + entry.priceText : ""}
          {entry.total !== null ? " · Rs " + entry.total : ""}
        </p>
      ) : null}
      <p className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-300">
        {entry.message}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void copyMessage()}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:bg-white/[0.06]"
        >
          {copied ? "Copied" : "Copy message"}
        </button>
        {entry.waLink ? (
          <a
            href={entry.waLink}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.08] px-2.5 py-1 text-[11px] text-emerald-300 transition-colors hover:bg-emerald-400/[0.14]"
          >
            Open WhatsApp
          </a>
        ) : null}
        <button
          onClick={() => void sendNow()}
          disabled={busy || sent}
          className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-2.5 py-1 text-[11px] text-cyan-300 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50"
        >
          {sent ? "Sent" : busy ? "Sending\u2026" : "Send via WhatsApp"}
        </button>
      </div>
      {note ? <p className="mt-1 text-[10px] text-amber-300">{note}</p> : null}
    </li>
  );
}

export default function WinbackPage() {
  const [data, setData] = useState<WinbackData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const payload = await fetch("/api/omniflow/portal/winback/queue", {
      cache: "no-store",
    })
      .then((response) =>
        response.ok ? (response.json() as Promise<WinbackData>) : null
      )
      .catch(() => null);
    if (payload && typeof payload === "object") {
      setData({
        cart: Array.isArray(payload.cart) ? payload.cart : [],
        reorder: Array.isArray(payload.reorder) ? payload.reorder : [],
        winback: Array.isArray(payload.winback) ? payload.winback : [],
        counts:
          payload.counts !== null && typeof payload.counts === "object"
            ? payload.counts
            : {},
        scored: typeof payload.scored === "number" ? payload.scored : 0,
      });
      setFailed(false);
    } else {
      setData(EMPTY);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = data?.counts ?? {};

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Win-back
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Ready-to-send recovery messages built from open carts, reorder gaps
          and quiet customers. Copy one, open WhatsApp, or send it through
          your connected number - nothing is ever sent automatically.
        </p>
      </div>

      {failed ? (
        <p className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-300">
          The queue is temporarily unavailable. Try again shortly.
        </p>
      ) : null}

      <p className="mb-4 text-xs text-slate-500">
        {counts.cart ?? 0} carts · {counts.reorder ?? 0} reorders ·{" "}
        {counts.winback ?? 0} win-backs
        {data && data.scored > 0 ? " · " + data.scored + " customers scored" : ""}
      </p>

      <div className="space-y-4">
        <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
          <p className="text-xs font-semibold text-white">Carts to recover</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Open checkout links waiting on a confirmation.
          </p>
          {(data?.cart.length ?? 0) === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              No open carts right now.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data!.cart.map((entry) => (
                <EntryCard key={entry.contactId + "-cart"} entry={entry} />
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
          <p className="text-xs font-semibold text-white">Reorder due</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Repeat buyers past their usual time-between-orders.
          </p>
          {(data?.reorder.length ?? 0) === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              No reorders due yet.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data!.reorder.map((entry) => (
                <EntryCard key={entry.contactId + "-reorder"} entry={entry} />
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
          <p className="text-xs font-semibold text-white">Win-back</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Paying customers who have gone quiet for 45+ days.
          </p>
          {(data?.winback.length ?? 0) === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              No quiet payers right now.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data!.winback.map((entry) => (
                <EntryCard key={entry.contactId + "-winback"} entry={entry} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
