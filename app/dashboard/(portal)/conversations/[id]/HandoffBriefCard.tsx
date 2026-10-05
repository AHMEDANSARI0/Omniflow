"use client";

import { useCallback, useEffect, useState } from "react";

import type { HandoffBrief, HandoffBriefView } from "../../../../../lib/omniflow/portal";

const SIGNAL_LABELS: [keyof NonNullable<HandoffBrief["signals"]>, string][] = [
  ["intent", "Intent"],
  ["sentiment", "Mood"],
  ["urgency", "Urgency"],
  ["purchase_intent", "Buying"],
  ["language", "Language"],
];

const ghostBtn =
  "rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-3 transition-colors duration-300 hover:text-ink disabled:opacity-50";

function words(value: string): string {
  return value.replace(/_/g, " ");
}

function money(value: number | null): string {
  return value === null ? "" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * §236 handoff brief: who the customer is, what they asked, why the AI
 * stopped and what is still open - so a teammate can reply without reading
 * the whole thread. Open by itself while a handoff is waiting; the AI
 * summary is optional (cached per last message, daily limit).
 */
export default function HandoffBriefCard({
  conversationId,
  escalationId,
  compact = false,
}: {
  conversationId?: number;
  escalationId?: number;
  compact?: boolean;
}) {
  const [view, setView] = useState<HandoffBriefView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(compact);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const base = conversationId
    ? "/api/omniflow/portal/conversations/" + String(conversationId) + "/handoff-brief"
    : "/api/omniflow/portal/escalations/" + String(escalationId) + "/brief";

  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const data = (await response.json()) as HandoffBriefView;
      setView(data);
      setFailed(false);
      if (data.brief.handoff?.status === "open") setOpen(true);
    } catch {
      setFailed(true);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function writeWithAi() {
    if (!view || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(view.brief.conversationId) + "/handoff-brief/ai",
        { method: "POST", credentials: "same-origin" }
      );
      const payload = (await response.json().catch(() => null)) as
        | (HandoffBriefView & { error?: { message?: string } })
        | null;
      if (response.ok && payload?.brief) {
        setView(payload);
        setNotice(payload.note || null);
      } else {
        setNotice(payload?.error?.message || "The AI brief is unavailable. Try again shortly.");
      }
    } catch {
      setNotice("Could not reach the workspace. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  if (failed && !compact) return null;
  if (failed) return <p className="mt-2 text-[11px] text-ink-3">The brief is unavailable right now.</p>;
  if (!view) {
    return compact ? <p className="mt-2 text-[11px] text-ink-3">{"Loading brief\u2026"}</p> : null;
  }
  const brief = view.brief;
  const signals = brief.signals;
  const shell = compact
    ? "mt-2 rounded-xl border border-line bg-soft p-3"
    : "mb-4 rounded-2xl border border-line bg-white shadow-card p-4";

  return (
    <section className={shell}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {compact ? null : <h2 className="text-xs font-semibold text-ink">Handoff brief</h2>}
          <p className="mt-0.5 text-xs text-ink-2">{brief.headline}</p>
        </div>
        {compact ? null : (
          <button type="button" onClick={() => setOpen((value) => !value)} className={ghostBtn}>
            {open ? "Hide" : "Show brief"}
          </button>
        )}
      </div>

      {open ? (
        <div className="mt-3 space-y-3 text-xs">
          {brief.ai && brief.ai.summary ? (
            <div className="rounded-lg border border-brand/20 bg-brand-soft px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-brand">
                AI summary{brief.ai.stale ? " \u00b7 older than the latest message" : ""}
              </p>
              <p className="mt-1 text-ink">{brief.ai.summary}</p>
              {brief.ai.nextStep ? (
                <p className="mt-1 text-ink-2">{"Next: " + brief.ai.nextStep}</p>
              ) : null}
            </div>
          ) : null}

          {brief.handoff ? (
            <p className="text-ink-2">
              <span className={brief.handoff.severity === "high" ? "text-amber-600" : "text-ink-3"}>
                {brief.handoff.status === "open" ? "Waiting handoff" : "Last handoff"}
              </span>
              {" \u00b7 " + brief.handoff.reasonLabel}
              {brief.handoff.note ? " \u00b7 " + brief.handoff.note : ""}
              {brief.handoff.hits > 1 ? " \u00b7 repeated " + brief.handoff.hits + " times" : ""}
            </p>
          ) : null}

          {brief.asked.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Customer asked</p>
              <ul className="mt-1 space-y-1">
                {brief.asked.map((item, index) => (
                  <li key={index} className="rounded-lg bg-soft px-2.5 py-1.5 text-ink">
                    {item.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {brief.lastReply ? (
            <p className="text-ink-3">
              {"Last reply" + (brief.lastReply.by ? " (" + brief.lastReply.by + ")" : "") + ": "}
              <span className="text-ink-2">{brief.lastReply.text}</span>
            </p>
          ) : null}

          {brief.aiReason && brief.aiReason.reason ? (
            <p className="text-ink-3">
              {"Why the AI stopped: "}
              <span className="text-ink-2">{brief.aiReason.reason}</span>
              {brief.aiReason.confidence !== null
                ? " \u00b7 confidence " + Math.round(brief.aiReason.confidence * 100) + "%"
                : ""}
            </p>
          ) : null}

          {signals ? (
            <div className="flex flex-wrap gap-1.5">
              {SIGNAL_LABELS.filter(([key]) => signals[key]).map(([key, label]) => (
                <span key={key} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-3">
                  {label + ": " + words(signals[key])}
                </span>
              ))}
            </div>
          ) : null}

          {brief.facts.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Remembered</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-2">
                {brief.facts.map((fact, index) => (
                  <li key={index}>{fact.text}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {brief.orders.length > 0 || brief.cod.length > 0 || brief.series.length > 0 ? (
            <div className="space-y-0.5 text-ink-3">
              {brief.orders.map((order) => (
                <p key={"o" + order.id}>
                  {"Order: " + (order.title || "#" + order.id)}
                  {order.total !== null ? " \u00b7 " + money(order.total) : ""}
                  {" \u00b7 " + words(order.status)}
                  {order.paid ? " \u00b7 paid " + money(order.paid) : ""}
                </p>
              ))}
              {brief.cod.map((item) => (
                <p key={"c" + item.id}>{"Cash on delivery: " + item.status}</p>
              ))}
              {brief.series.map((item) => (
                <p key={"s" + item.id}>{"Follow-up series: " + item.name + " (" + item.status + ")"}</p>
              ))}
            </div>
          ) : null}

          {brief.nextSteps.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Suggested next steps</p>
              <ul className="mt-1 space-y-0.5 text-ink-2">
                {brief.nextSteps.map((step, index) => (
                  <li key={index}>{"\u2713 " + step}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {compact ? (
              <a
                href={"/dashboard/conversations/" + String(brief.conversationId)}
                className={ghostBtn}
              >
                Open chat
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => void writeWithAi()}
              disabled={busy || !view.aiReady}
              title={view.aiReady ? "Write a short summary with AI" : view.aiReason}
              className={ghostBtn}
            >
              {busy ? "Writing\u2026" : brief.ai && !brief.ai.stale ? "AI summary is current" : "Summarise with AI"}
            </button>
            {!view.aiReady && view.aiReason ? (
              <span className="text-[10px] text-ink-3">{view.aiReason}</span>
            ) : null}
          </div>
          {notice ? <p className="text-[11px] text-amber-600">{notice}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
