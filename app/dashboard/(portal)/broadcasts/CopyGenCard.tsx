"use client";

import { useState } from "react";

const LANGS: { value: "ur" | "roman" | "en"; label: string }[] = [
  { value: "roman", label: "Roman Urdu" },
  { value: "ur", label: "اردو" },
  { value: "en", label: "English" },
];

/**
 * Broadcasts -> AI copy: two short variants per topic/language.
 * Text only - the owner edits and sends through the normal broadcast
 * flow (edit-before-send). Falls back to fixed templates without an
 * LLM key, so it always produces something usable.
 */
export default function CopyGenCard() {
  const [topic, setTopic] = useState("");
  const [lang, setLang] = useState<"ur" | "roman" | "en">("roman");
  const [variants, setVariants] = useState<string[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(-1);

  async function generate() {
    const clean = topic.trim();
    if (!clean) return;
    setBusy(true);
    setVariants([]);
    setSource(null);
    try {
      const response = await fetch("/api/omniflow/portal/copygen/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: clean, lang }),
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          variants?: string[];
          source?: string;
        };
        setVariants(payload.variants ?? []);
        setSource(payload.source ?? null);
      }
    } catch {
      /* nothing to do - the empty state speaks for itself */
    } finally {
      setBusy(false);
    }
  }

  async function copy(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      setTimeout(() => setCopied(-1), 1500);
    } catch {
      /* clipboard unavailable - the owner can select the text */
    }
  }

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <p className="text-xs font-semibold text-white">AI copy helper</p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Topic likhein - do short variants ban jayenge. Text sirf yahan
        copy hota he; bhejne se pehle aap edit karte hain.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder="e.g. winter sale 20% off shawls"
          className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
        />
        <select
          value={lang}
          onChange={(event) =>
            setLang(event.target.value as "ur" | "roman" | "en")
          }
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-xs text-slate-300 outline-none"
        >
          {LANGS.map((option) => (
            <option key={option.value} value={option.value} className="bg-[#101418]">
              {option.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => void generate()}
          disabled={busy || !topic.trim()}
          className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
        >
          {busy ? "Generating..." : "Generate"}
        </button>
      </div>
      {variants.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {variants.map((text, index) => (
            <li
              key={index}
              className="flex items-start justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
            >
              <p className="min-w-0 text-xs text-slate-300">{text}</p>
              <button
                onClick={() => void copy(index, text)}
                className="shrink-0 text-[11px] text-cyan-300 hover:underline"
              >
                {copied === index ? "Copied" : "Copy"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {source ? (
        <p className="mt-1.5 text-[10px] text-slate-600">
          {source === "llm"
            ? "AI-generated - edit before sending."
            : "Template copy (no AI key set) - edit before sending."}
        </p>
      ) : null}
    </section>
  );
}
