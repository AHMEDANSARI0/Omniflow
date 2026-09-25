"use client";

import { useState } from "react";

export default function StoreOrder({
  slug,
  itemId,
}: {
  slug: string;
  itemId: number;
}) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  async function order() {
    if (busy) return;
    if (!phone.trim()) {
      setNote({ text: "Enter your WhatsApp number.", ok: false });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/public/store/" + encodeURIComponent(slug) + "/order",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: phone.trim(),
            name: name.trim(),
            item_id: itemId,
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        url?: string;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok && payload.url) {
        setNote({
          text: "Order link sent to your WhatsApp — confirm it there.",
          ok: true,
        });
        setOpen(false);
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not place the order — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not place the order — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  if (note && note.ok) {
    return (
      <p className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.08] px-3 py-2 text-[11px] text-ok">
        {note.text}
      </p>
    );
  }

  return (
    <div className="mt-3">
      {open ? (
        <div className="space-y-2">
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="numeric"
            placeholder="WhatsApp number, e.g. 923001234567"
            autoComplete="off"
            className="w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none"
          />
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name (optional)"
            autoComplete="off"
            className="w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => void order()}
              disabled={busy}
              className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.1] px-3 py-2 text-xs font-semibold text-ok hover:bg-emerald-400/[0.18] disabled:opacity-50"
            >
              {busy ? "Sending…" : "Confirm order"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink-3 hover:bg-white/[0.06]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.08] px-3 py-2 text-xs font-semibold text-ok hover:bg-emerald-400/[0.14]"
        >
          Order on WhatsApp
        </button>
      )}
      {note && !note.ok ? (
        <p className="mt-2 text-[11px] text-danger">{note.text}</p>
      ) : null}
    </div>
  );
}
