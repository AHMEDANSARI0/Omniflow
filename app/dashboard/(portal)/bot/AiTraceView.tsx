"use client";

import { useCallback, useEffect, useState } from "react";

/** §241 AI execution traces: what each AI answer read, cost and decided. */

interface TraceSummary {
  id: number;
  created_at: string | null;
  kind: string;
  kind_label: string;
  decision: string;
  conversation_id: number | null;
  agent: { id: number; name: string } | null;
  model: string | null;
  tokens: number;
  latency_ms: number | null;
  cost_usd: number | null;
  confidence: number | null;
  reason: { key: string; label: string; detail: string } | null;
  tools: string[];
}

interface TraceList {
  kinds: { key: string; label: string }[];
  items: TraceSummary[];
}

interface TraceStep {
  key: string;
  label: string;
  status: string;
  detail: Record<string, unknown>;
}

interface TraceDetail {
  id: number;
  created_at: string | null;
  kind_label: string;
  decision: string;
  conversation_id: number | null;
  channel: string | null;
  steps: TraceStep[];
  audit: { id: number; action: string; note: string }[];
}

const DOT: Record<string, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  blocked: "bg-rose-400",
  failed: "bg-rose-400",
};

const MATCH_NOTE: Record<string, string> = {
  same_time: "Matched by time (several messages arrived together).",
  nearest: "Nearest earlier message (approximate match).",
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
}

function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function money(value: number | null): string {
  return value === null ? "no price" : "$" + value.toFixed(value < 0.01 ? 5 : 4);
}

function decisionLabel(decision: string): string {
  return decision === "send" ? "Sent by AI" : "Handed to the team";
}

function StepBody({ step }: { step: TraceStep }) {
  const d = step.detail;
  if (step.key === "input") {
    const body = text(d.body);
    return body ? (
      <>
        <p className="whitespace-pre-wrap rounded-lg bg-soft px-2.5 py-1.5 text-xs text-ink">{body}</p>
        {MATCH_NOTE[text(d.match)] ? <p className="mt-1 text-[10px] text-ink-3">{MATCH_NOTE[text(d.match)]}</p> : null}
      </>
    ) : (
      <p className="text-[11px] text-ink-3">{text(d.note)}</p>
    );
  }
  if (step.key === "guard") {
    const signals = Array.isArray(d.signals) ? d.signals.map(String) : [];
    return text(d.level) ? (
      <p className="text-[11px] text-ink-2">
        Risk {text(d.level)}
        {signals.length ? " \u00b7 " + signals.join(", ") : ""}
        {text(d.mode) ? " \u00b7 mode " + text(d.mode) : ""}
      </p>
    ) : (
      <p className="text-[11px] text-ink-3">Not recorded for this answer.</p>
    );
  }
  if (step.key === "agent") {
    const version = num(d.version);
    return (
      <p className="text-[11px] text-ink-2">
        {text(d.name)}
        {version !== null ? " \u00b7 version " + version : ""}
        {d.in_hours === false ? " \u00b7 outside working hours" : ""}
        {d.auto_reply === false ? " \u00b7 drafts only" : ""}
      </p>
    );
  }
  if (step.key === "tools") {
    const items = list(d.items);
    return items.length ? (
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={text(item.key)} className="text-[11px] text-ink-2">
            <span className="text-ink">{text(item.label)}</span>
            {text(item.detail) ? " \u2014 " + text(item.detail) : ""}
            {Array.isArray(item.refs) && item.refs.length ? (
              <span className="text-ink-3"> ({item.refs.map(String).join(", ")})</span>
            ) : null}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-[11px] text-ink-3">Nothing was read.</p>
    );
  }
  if (step.key === "model") {
    const calls = list(d.calls);
    const timings = d.timings_ms && typeof d.timings_ms === "object" ? (d.timings_ms as Record<string, unknown>) : null;
    return (
      <>
        {calls.length ? (
          <ul className="space-y-0.5">
            {calls.map((call, index) => (
              <li key={index} className="text-[11px] text-ink-2">
                <span className="text-ink">{text(call.model) || "model"}</span>
                {" \u00b7 "}
                {(num(call.prompt_tokens) ?? 0) + " + " + (num(call.completion_tokens) ?? 0) + " tokens"}
                {" \u00b7 "}
                {(num(call.latency_ms) ?? 0) + " ms"}
                {d.prices_configured ? " \u00b7 " + money(num(call.cost_usd)) : ""}
                {text(call.route) ? " \u00b7 route " + text(call.route) : ""}
                {call.ok === false ? <span className="text-danger">{" \u00b7 failed"}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-ink-3">
            {step.status === "skipped" ? "The model was not called." : "Model details were not recorded for this answer."}
          </p>
        )}
        {timings ? (
          <p className="mt-0.5 text-[10px] text-ink-3">
            Context {num(timings.tools) ?? 0} ms {" \u00b7 "} model {num(timings.model) ?? 0} ms
          </p>
        ) : null}
      </>
    );
  }
  if (step.key === "decision") {
    const confidence = num(d.confidence);
    const reason = d.reason && typeof d.reason === "object" ? (d.reason as Record<string, unknown>) : null;
    return (
      <p className="text-[11px] text-ink-2">
        <span className="text-ink">{decisionLabel(text(d.decision))}</span>
        {confidence !== null ? " \u00b7 confidence " + Math.round(confidence * 100) + "%" : ""}
        {reason ? " \u00b7 " + text(reason.label) + (text(reason.detail) ? " (" + text(reason.detail) + ")" : "") : ""}
      </p>
    );
  }
  const body = text(d.body);
  return body ? (
    <>
      <p className="whitespace-pre-wrap rounded-lg bg-brand-soft px-2.5 py-1.5 text-xs text-ink">{body}</p>
      {text(d.status) ? <p className="mt-1 text-[10px] text-ink-3">Delivery: {text(d.status)}</p> : null}
    </>
  ) : (
    <p className="text-[11px] text-ink-3">
      {text(d.note)}
      {d.escalated === true ? " A handoff was opened." : ""}
    </p>
  );
}

/** One AI answer, step by step. */
export function AiTraceDetailView({ traceId, onClose }: { traceId: number; onClose: () => void }) {
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let live = true;
    setState("loading");
    fetch("/api/omniflow/portal/ai/traces/" + traceId, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 404) return setState("missing");
        if (!response.ok) return setState("error");
        setTrace((await response.json()) as TraceDetail);
        setState("ready");
      })
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, [traceId]);

  return (
    <div className="mt-3 rounded-xl border border-brand/30 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-ink">AI answer #{traceId}</p>
          {trace ? (
            <p className="text-[10px] text-ink-3">
              {trace.kind_label}
              {trace.channel ? " \u00b7 " + trace.channel : ""}
              {" \u00b7 "}
              {when(trace.created_at)}
              {trace.conversation_id ? (
                <>
                  {" \u00b7 "}
                  <a href={"/dashboard/conversations/" + trace.conversation_id} className="text-brand hover:underline">
                    open chat
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-line px-2 py-1 text-[10px] text-ink-3 hover:text-ink"
        >
          Close
        </button>
      </div>
      {state === "loading" ? (
        <p className="mt-2 text-xs text-ink-3">Loading&#8230;</p>
      ) : state === "missing" ? (
        <p className="mt-2 text-xs text-ink-3">This answer is no longer on record.</p>
      ) : state === "error" || !trace ? (
        <p className="mt-2 text-xs text-ink-3">The trace is unavailable right now. Try again shortly.</p>
      ) : (
        <>
          <ol className="mt-3 space-y-2.5">
            {trace.steps.map((step) => (
              <li key={step.key} className="flex gap-2.5">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[step.status] ?? "border border-line bg-soft"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-wider text-ink-3">{step.label}</p>
                  <StepBody step={step} />
                </div>
              </li>
            ))}
          </ol>
          {trace.audit.length ? (
            <div className="mt-3 border-t border-line pt-2">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Audit log</p>
              <ul className="mt-1 space-y-0.5">
                {trace.audit.map((row) => (
                  <li key={row.id} className="text-[11px] text-ink-2">
                    <span className="text-ink">{row.action}</span> {row.note ? "\u2014 " + row.note : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Newest AI answers with filters; a row opens its step-by-step trace. */
export function AiTracesPanel({ days, onOpen }: { days: number; onOpen: (id: number) => void }) {
  const [data, setData] = useState<TraceList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [decision, setDecision] = useState("");
  const [kind, setKind] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ days: String(days), limit: "50" });
    if (decision) params.set("decision", decision);
    if (kind) params.set("kind", kind);
    try {
      const response = await fetch("/api/omniflow/portal/ai/traces?" + params.toString(), {
        credentials: "same-origin",
        cache: "no-store",
      });
      setData(response.ok ? ((await response.json()) as TraceList) : null);
    } catch {
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, [days, decision, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-[10px] ${
      active ? "border-brand/30 bg-brand-soft text-brand" : "border-line text-ink-3"
    }`;

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {[
          ["", "All"],
          ["send", "Sent by AI"],
          ["handoff", "Handed to the team"],
        ].map(([key, label]) => (
          <button key={key || "all"} type="button" onClick={() => setDecision(key)} className={chip(decision === key)}>
            {label}
          </button>
        ))}
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          aria-label="Answer type"
          className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-ink-3"
        >
          <option value="">Every type</option>
          {(data?.kinds ?? []).map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      {!loaded ? (
        <p className="mt-3 text-xs text-ink-3">Loading&#8230;</p>
      ) : !data ? (
        <p className="mt-3 text-xs text-ink-3">Traces are unavailable right now.</p>
      ) : data.items.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">No AI answers in this window.</p>
      ) : (
        <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {data.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                className="w-full rounded-xl border border-line px-3 py-1.5 text-left hover:border-brand/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-xs text-ink">
                    <span className={item.decision === "send" ? "text-ok" : "text-danger"}>
                      {decisionLabel(item.decision)}
                    </span>
                    {item.reason ? <span className="text-ink-3"> {"\u00b7"} {item.reason.label}</span> : null}
                  </p>
                  <span className="shrink-0 text-[10px] text-ink-3">{when(item.created_at)}</span>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-ink-3">
                  {item.kind_label}
                  {item.agent ? " \u00b7 " + item.agent.name : ""}
                  {item.model ? " \u00b7 " + item.model : ""}
                  {item.tokens ? " \u00b7 " + item.tokens + " tokens" : ""}
                  {item.latency_ms !== null ? " \u00b7 " + item.latency_ms + " ms" : ""}
                  {item.cost_usd !== null ? " \u00b7 " + money(item.cost_usd) : ""}
                  {item.confidence !== null ? " \u00b7 " + Math.round(item.confidence * 100) + "%" : ""}
                  {item.tools.length ? " \u00b7 " + item.tools.join(", ") : ""}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
