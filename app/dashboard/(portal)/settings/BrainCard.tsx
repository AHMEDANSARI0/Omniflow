"use client";

import { useCallback, useEffect, useState } from "react";

type Autonomy = "off" | "suggest" | "auto";

const LEVELS: { value: Autonomy; label: string; hint: string }[] = [
  {
    value: "off",
    label: "Off",
    hint: "The AI brain never runs (rollback switch).",
  },
  {
    value: "suggest",
    label: "Suggest only",
    hint: "Drafts on request — nothing is ever sent automatically.",
  },
  {
    value: "auto",
    label: "Auto-answer",
    hint: "The brain may answer inbound messages itself (policy + confidence guarded).",
  },
];

/**
 * Settings -> AI Brain: autonomy level + tone. The brain answers with
 * tools (orders, KB, conversation), policy checks and full traces.
 */
export default function BrainCard() {
  const [autonomy, setAutonomy] = useState<Autonomy>("suggest");
  const [tone, setTone] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/brain/settings", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          settings?: { autonomy?: Autonomy; tone?: string };
        };
        if (payload.settings?.autonomy) setAutonomy(payload.settings.autonomy);
        setTone(payload.settings?.tone ?? "");
        setLoaded(true);
      }
    } catch {
      setNote("Could not load AI Brain settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: Autonomy, nextTone: string) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/brain/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autonomy: next, tone: nextTone }),
      });
      if (response.ok) {
        setAutonomy(next);
        setTone(nextTone);
        setNote("Saved.");
      } else {
        setNote("Could not save. Try again shortly.");
      }
    } catch {
      setNote("Could not save. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-soft p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">AI Brain</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Answers from your orders, knowledge base and the conversation —
            policy-checked, with provenance traces. Never invents facts.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:bg-soft disabled:opacity-50"
        >
          {busy ? "Loading..." : "Refresh"}
        </button>
      </div>

      {loaded ? (
        <div className="mt-3 space-y-2">
          {LEVELS.map((level) => (
            <button
              key={level.value}
              onClick={() => void save(level.value, tone)}
              disabled={busy}
              className={
                "block w-full rounded-xl border px-3 py-2 text-left transition-colors " +
                (autonomy === level.value
                  ? "border-emerald-400/30 bg-emerald-400/[0.07]"
                  : "border-line bg-soft hover:bg-soft")
              }
            >
              <span className="text-xs font-semibold text-ink">
                {level.label}
              </span>
              <span className="ml-2 text-[11px] text-ink-3">
                {level.hint}
              </span>
            </button>
          ))}
          <label className="block pt-1">
            <span className="text-[11px] text-ink-3">
              Reply tone (optional)
            </span>
            <div className="mt-1 flex gap-2">
              <input
                value={tone}
                onChange={(event) => setTone(event.target.value)}
                placeholder="e.g. warm, concise, friendly"
                className="min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-white/[0.2]"
              />
              <button
                onClick={() => void save(autonomy, tone)}
                disabled={busy}
                className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-50"
              >
                Save tone
              </button>
            </div>
          </label>
          {note ? <p className="text-[11px] text-ink-3">{note}</p> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-3">Loading…</p>
      )}
    </section>
  );
}
