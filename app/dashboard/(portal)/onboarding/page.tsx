"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface PackPersona {
  agent_name: string;
  tone: string;
  greeting: string;
  fallback: string;
}

interface Pack {
  key: string;
  label: string;
  description: string;
  persona: PackPersona;
  kb: { title: string; category: string; keywords: string;
        content: string; lang: string }[];
  keywords: { keyword: string; note: string }[];
  saved_replies: { shortcut: string; body: string }[];
  journey: string[];
}

/**
 * Setup wizard: pick a vertical, see exactly what will be created
 * (persona, knowledge-base entries, saved replies, keyword alerts,
 * journey stages), then activate with one click. Everything the
 * template seeds can be edited or deleted normally afterwards.
 */
export default function OnboardingPage() {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [applied, setApplied] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/templates",
        { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as {
          packs?: Pack[];
          applied?: string;
        };
        setPacks(payload.packs ?? []);
        setApplied(payload.applied ?? "");
      } else {
        setPacks([]);
      }
    } catch {
      setPacks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function applyTemplate(key: string) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/templates/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vertical: key }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | { created?: Record<string, number>;
            error?: { message?: string } }
        | null;
      if (response.ok && payload?.created) {
        setApplied(key);
        setNote("Template activated - " + (payload.created.kb ?? 0)
          + " knowledge entries, " + (payload.created.saved_replies ?? 0)
          + " saved replies, " + (payload.created.keywords ?? 0)
          + " keyword alerts, " + (payload.created.journey ?? 0)
          + " journey stages"
          + (payload.created.persona
            ? ", assistant persona"
            : " (persona untouched)"));
        await load();
      } else {
        setNote(payload?.error?.message ?? "Could not apply the template.");
      }
    } catch {
      setNote("Could not apply the template - try again.");
    } finally {
      setBusy(false);
    }
  }

  const active = packs?.find((pack) => pack.key === selected) ?? null;

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Setup wizard
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Pick your business type - the wizard seeds a matching
            assistant persona, starter knowledge-base entries, saved
            replies, keyword alerts and journey stages. Everything is
            editable afterwards.
          </p>
          {applied ? (
            <p className="mt-2 text-[11px] text-emerald-300">
              &#10003; Currently applied: {applied}
            </p>
          ) : null}
        </div>

        {!packs ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            aria-busy="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={String(index)}
                className="h-28 animate-pulse rounded-2xl bg-white/5"
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packs.map((pack) => (
              <button
                key={pack.key}
                onClick={() => setSelected(pack.key)}
                className={
                  "rounded-2xl border p-4 text-left transition-colors duration-300 " +
                  (selected === pack.key
                    ? "border-cyan-400/40 bg-cyan-400/[0.07]"
                    : "border-white/[0.06] bg-white/[0.015] hover:border-cyan-400/25 hover:bg-cyan-400/[0.04]")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-white">
                    {pack.label}
                  </p>
                  {applied === pack.key ? (
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-[10px] text-emerald-200">
                      Active
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                  {pack.description}
                </p>
              </button>
            ))}
          </div>
        )}

        {active ? (
          <section className="mt-4 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.03] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-white">
                Preview: {active.label}
              </p>
              <button
                onClick={() => void applyTemplate(active.key)}
                disabled={busy}
                className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
              >
                {applied === active.key
                  ? "Re-apply (fills gaps only)"
                  : "Activate this template"}
              </button>
            </div>

            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-600">
                  Assistant persona
                </p>
                <p className="mt-1 text-[11px] text-slate-300">
                  {active.persona.agent_name}
                  {" \u00b7 "}{active.persona.tone}
                </p>
                <p className="mt-1 rounded-lg border border-white/[0.06] bg-white/[0.015] px-2.5 py-1.5 text-[11px] italic text-slate-400">
                  &ldquo;{active.persona.greeting}&rdquo;
                </p>
                <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-600">
                  Keyword alerts
                </p>
                <ul className="mt-1 space-y-0.5">
                  {active.keywords.map((rule) => (
                    <li key={rule.keyword}
                      className="text-[11px] text-slate-400">
                      <span className="text-cyan-300">
                        {rule.keyword}
                      </span>{" "}
                      &mdash; {rule.note}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-600">
                  Journey stages
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {active.journey.join(" \u2192 ")}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-600">
                  Knowledge-base entries
                </p>
                <ul className="mt-1 space-y-1">
                  {active.kb.map((entry) => (
                    <li key={entry.title}
                      className="rounded-lg border border-white/[0.05] bg-white/[0.01] px-2.5 py-1.5">
                      <p className="text-[11px] text-slate-200">
                        {entry.title}
                        <span className="ml-2 text-[10px] text-slate-600">
                          {entry.category}
                        </span>
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[10px] text-slate-500">
                        {entry.content}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-600">
                  Saved replies
                </p>
                <ul className="mt-1 space-y-0.5">
                  {active.saved_replies.map((reply) => (
                    <li key={reply.shortcut}
                      className="text-[11px] text-slate-400">
                      <span className="text-cyan-300">
                        {reply.shortcut}
                      </span>{" "}
                      &mdash; {reply.body}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        ) : null}

        {note ? (
          <p className="mt-3 text-[11px] text-slate-300">{note}</p>
        ) : null}

        {applied ? (
          <p className="mt-4 text-[11px] text-slate-500">
            Next steps:{" "}
            <Link href="/dashboard/bot"
              className="text-cyan-300 hover:underline">
              review the assistant
            </Link>
            {" \u00b7 "}
            <Link href="/dashboard/knowledge-base"
              className="text-cyan-300 hover:underline">
              edit knowledge entries
            </Link>
            {" \u00b7 "}
            <Link href="/dashboard/saved-replies"
              className="text-cyan-300 hover:underline">
              adjust saved replies
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
