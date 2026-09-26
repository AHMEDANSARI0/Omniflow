"use client";

import { useState } from "react";

interface AddressIntel {
  normalized: string;
  city: string | null;
  phone: string | null;
  issues: string[];
  ask_prompts: string[];
}

/**
 * Address intelligence: paste a free-text customer address, get the
 * cleaned version (city + phone extracted), what is missing, and the
 * exact Roman-Urdu questions to ask - ready to copy into the chat.
 */
export default function AddressCard() {
  const [address, setAddress] = useState("");
  const [intel, setIntel] = useState<AddressIntel | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function normalize() {
    const clean = address.trim();
    if (!clean) return;
    setBusy(true);
    setIntel(null);
    try {
      const response = await fetch("/api/omniflow/portal/address/normalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: clean }),
      });
      if (response.ok) {
        setIntel((await response.json()) as AddressIntel);
      }
    } catch {
      /* empty state speaks for itself */
    } finally {
      setBusy(false);
    }
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-line bg-soft p-4">
      <p className="text-xs font-semibold text-ink">Address check</p>
      <p className="mt-0.5 text-[11px] text-ink-3">
        Paste an address - it is cleaned, the city and phone are
        extracted, and ready-to-send questions cover anything
        missing.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="e.g. hno 12 blk c gulshan-e-iqbal karachi 03001234567"
          className="min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
        />
        <button
          onClick={() => void normalize()}
          disabled={busy || !address.trim()}
          className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-40"
        >
          Check address
        </button>
      </div>

      {intel ? (
        <div className="mt-3 space-y-2 rounded-xl border border-line bg-soft p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-words text-xs text-ink">
              {intel.normalized}
            </p>
            <button
              onClick={() => void copy("norm", intel.normalized)}
              className="shrink-0 text-[11px] text-brand hover:underline"
            >
              {copied === "norm" ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[11px] text-ink-3">
            City: {intel.city ?? "not found"} &middot; Phone:{" "}
            {intel.phone ?? "not found"}
          </p>
          {intel.ask_prompts.length > 0 ? (
            <ul className="space-y-1">
              {intel.ask_prompts.map((prompt, index) => (
                <li
                  key={index}
                  className="flex items-center justify-between gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-2.5 py-1.5"
                >
                  <span className="min-w-0 text-[11px] text-amber-200">
                    {prompt}
                  </span>
                  <button
                    onClick={() => void copy(index + prompt, prompt)}
                    className="shrink-0 text-[11px] text-ink-3 hover:underline"
                  >
                    {copied === index + prompt ? "Copied" : "Copy"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-ok">
              Address looks complete - nothing to ask.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
