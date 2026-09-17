"use client";

import { useCallback, useEffect, useState } from "react";

export default function DigestCard() {
  const [enabled, setEnabled] = useState(false);
  const [ownerContact, setOwnerContact] = useState("");
  const [hour, setHour] = useState(9);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/digest/settings", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        settings?: {
          enabled?: boolean;
          ownerContact?: string;
          hour?: number;
        };
      } | null;
      const s = payload?.settings;
      if (!s) return;
      setEnabled(s.enabled === true);
      setOwnerContact(typeof s.ownerContact === "string" ? s.ownerContact : "");
      setHour(typeof s.hour === "number" ? s.hour : 9);
      setVisible(true);
    } catch {
      return;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/digest/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          settings: {
            enabled,
            owner_contact: ownerContact.trim().slice(0, 100),
            hour,
          },
        }),
      });
      if (response.ok) {
        setNote(
          enabled
            ? "Saved. Your digest arrives once a day on WhatsApp."
            : "Saved. The digest is off."
        );
      } else if (response.status === 400) {
        setNote("Add your WhatsApp number (and keep the hour between 6 and 21).");
      } else {
        setNote("Could not save right now. Try again shortly.");
      }
    } catch {
      setNote("Could not save right now. Try again shortly.");
    } finally {
      setSaving(false);
    }
  }

  if (loaded && !visible) return null;

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Daily digest
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            One WhatsApp a day to yourself: orders paid today, open carts and
            returns. Sent after the hour you pick.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((prev) => !prev)}
          className={`rounded-lg border px-2.5 py-1 text-[11px] ${
            enabled
              ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
              : "border-white/[0.08] bg-white/[0.02] text-slate-400"
          }`}
        >
          {enabled ? "Digest on" : "Digest off"}
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] text-slate-400">
            Your WhatsApp number
          </span>
          <input
            type="text"
            value={ownerContact}
            onChange={(event) => setOwnerContact(event.target.value)}
            placeholder="923001234567"
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-white/20 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-400">Send after (hour)</span>
          <input
            type="number"
            min={6}
            max={21}
            value={hour}
            onChange={(event) =>
              setHour(Number(event.target.value) || 0)
            }
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200 hover:bg-white/[0.08] disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {note ? <span className="text-[11px] text-slate-500">{note}</span> : null}
      </div>
    </section>
  );
}
