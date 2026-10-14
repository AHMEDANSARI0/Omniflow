"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

const HandoffBriefCard = dynamic(() => import("../conversations/[id]/HandoffBriefCard"));

interface Escalation {
  id: number;
  conversation_id: number;
  contact_name: string;
  contact_id: string;
  reason: string;
  reason_label: string;
  source: string;
  severity: "normal" | "high";
  note: string;
  target_user_id: number | null;
  status: "open" | "resolved";
  hits: number;
  created_at: string | null;
  resolved_at: string | null;
  resolved_note: string;
}

interface Summary {
  open: number;
  open_high: number;
  opened_7d: number;
  resolved_7d: number;
  avg_resolve_minutes: number | null;
  by_source: Record<string, number>;
  top_reasons: { label: string; count: number }[];
}

interface Payload {
  items: Escalation[];
  summary: Summary;
  sources: string[];
}

const SOURCE_LABEL: Record<string, string> = {
  ai: "AI Brain",
  workflow: "Workflow",
  kb: "Knowledge gaps",
  rule: "Rule",
  human: "Team",
  system: "System",
};

const ghostBtn =
  "rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-3 transition-colors duration-300 hover:text-ink disabled:opacity-50";

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

/**
 * Configure AI -> Handoffs: every chat the AI, a workflow or the knowledge
 * gap detector handed to a human, in one queue with the reason, who got it
 * and how long it has been waiting. Resolve is explicit so the queue stays
 * honest; the 7-day summary shows what keeps tripping the assistant.
 */
export default function EscalationsCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [briefId, setBriefId] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/escalations?status=" + status + "&limit=50",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) {
        setData(null);
        return;
      }
      setData((await response.json()) as Payload);
    } catch {
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(item: Escalation) {
    setBusyId(item.id);
    setNotice(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/escalations/" + item.id + "/resolve",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: "" }),
        }
      );
      if (!response.ok) {
        setNotice("That handoff could not be resolved. It may already be closed.");
      } else {
        setNotice("Marked as handled.");
      }
      await load();
    } catch {
      setNotice("Could not reach the workspace. Try again shortly.");
    } finally {
      setBusyId(0);
    }
  }

  const summary = data?.summary;

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Handoffs to your team</h2>
          <p className="mt-1 text-xs text-ink-3">
            Chats the assistant, a workflow or the knowledge-gap detector passed
            to a person. Each one is assigned to the persona&apos;s escalation
            contact, or the first teammate, and you are notified.
          </p>
        </div>
        {summary ? (
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            <span className="rounded-full border border-line px-2 py-0.5 text-ink-3">
              {summary.open} open
              {summary.open_high > 0 ? " \u00b7 " + summary.open_high + " high" : ""}
            </span>
            <span className="rounded-full border border-line px-2 py-0.5 text-ink-3">
              {summary.opened_7d} opened / {summary.resolved_7d} resolved in 7 days
            </span>
            {summary.avg_resolve_minutes !== null ? (
              <span className="rounded-full border border-line px-2 py-0.5 text-ink-3">
                avg {summary.avg_resolve_minutes} min to resolve
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {summary && summary.top_reasons.length > 0 ? (
        <p className="mt-3 text-[11px] text-ink-3">
          Top reasons this week:{" "}
          {summary.top_reasons
            .map((reason) => reason.label + " (" + reason.count + ")")
            .join(" \u00b7 ")}
        </p>
      ) : null}

      <div className="mt-3 flex gap-1.5">
        {(["open", "resolved"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setStatus(option)}
            className={`rounded-lg border inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-medium transition-colors ${
              status === option
                ? "border-brand/30 bg-brand-soft text-brand"
                : "border-line bg-soft text-ink-3 hover:text-ink"
            }`}
          >
            {option === "open" ? "Waiting" : "Handled"}
          </button>
        ))}
      </div>

      {!loaded ? (
        <p className="mt-3 text-xs text-ink-3">Loading&#8230;</p>
      ) : !data ? (
        <p className="mt-3 text-xs text-ink-3">Handoffs are unavailable right now. Try again shortly.</p>
      ) : data.items.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">
          {status === "open"
            ? "Nothing is waiting. The assistant has not needed help recently."
            : "No handled handoffs yet."}
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {data.items.map((item) => (
            <li key={item.id} className="rounded-xl border border-line px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-xs text-ink">
                  {item.severity === "high" ? (
                    <span className="mr-1 text-amber-700">&#9679;</span>
                  ) : null}
                  <a
                    href={"/dashboard/conversations/" + item.conversation_id}
                    className="font-medium hover:underline"
                  >
                    {item.contact_name || item.contact_id || "Conversation #" + item.conversation_id}
                  </a>
                  <span className="text-ink-3">{" \u00b7 "}{item.reason_label}</span>
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-ink-3">{formatWhen(item.created_at)}</span>
                  <button
                    type="button"
                    onClick={() => setBriefId((current) => (current === item.id ? 0 : item.id))}
                    className={ghostBtn}
                  >
                    {briefId === item.id ? "Hide brief" : "Brief"}
                  </button>
                  {item.status === "open" ? (
                    <button
                      type="button"
                      onClick={() => void resolve(item)}
                      disabled={busyId === item.id}
                      className={ghostBtn}
                    >
                      {busyId === item.id ? "Working\u2026" : "Resolve"}
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="mt-0.5 text-[10px] text-ink-3">
                {SOURCE_LABEL[item.source] ?? item.source}
                {item.target_user_id ? " \u00b7 assigned to user " + item.target_user_id : " \u00b7 unassigned"}
                {item.hits > 1 ? " \u00b7 repeated " + item.hits + " times" : ""}
                {item.note ? " \u00b7 " + item.note : ""}
                {item.status === "resolved" && item.resolved_note ? " \u00b7 " + item.resolved_note : ""}
              </p>
              {briefId === item.id ? <HandoffBriefCard escalationId={item.id} compact /> : null}
            </li>
          ))}
        </ul>
      )}
      {notice ? <p className="mt-2 text-xs text-ink-3">{notice}</p> : null}
    </section>
  );
}
