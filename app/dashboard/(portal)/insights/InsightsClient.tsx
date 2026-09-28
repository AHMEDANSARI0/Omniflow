"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { BiProblem, BiReport, BiTopic } from "../../../../lib/omniflow/portal";

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-rose-400/30 bg-rose-400/[0.08] text-danger",
  warn: "border-amber-400/30 bg-amber-400/[0.08] text-amber-700",
  info: "border-line text-ink-3",
};

const SOURCE_LABEL: Record<string, string> = {
  ai: "AI Brain",
  workflow: "Workflows",
  kb: "Knowledge gaps",
  rule: "Rules",
  human: "Team",
  system: "System",
};

const REASON_LABEL: Record<string, string> = {
  needs_human: "asked for a human",
  low_confidence: "not confident",
  policy: "blocked by policy",
  llm_unavailable: "AI engine unavailable",
  empty_reply: "empty reply",
  injection_suspected: "suspicious message blocked",
  output_guard: "reply withheld by the output guard",
};

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "\u2014";
  return Math.round(value * 100) + "%";
}

function hourLabel(hour: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return h + suffix;
}

function trendGlyph(trend: BiTopic["trend"]): string {
  if (trend === "up") return "\u25b3";
  if (trend === "down") return "\u25bd";
  if (trend === "new") return "\u2726";
  return "\u2013";
}

function evidenceLines(evidence: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (value === null || value === undefined || key === "examples") continue;
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => typeof v === "number" || typeof v === "string")
        .slice(0, 4)
        .map(([k, v]) => k + " " + String(v));
      if (entries.length) lines.push(key.replace(/_/g, " ") + ": " + entries.join(", "));
      continue;
    }
    const shown =
      typeof value === "number" && key.includes("share") ? pct(value) : String(value);
    lines.push(key.replace(/_/g, " ") + ": " + shown);
  }
  return lines;
}

function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-soft p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <p className="mt-1 text-xs text-ink-3">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-ink-3">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-ink">{value}</p>
      {hint ? <p className="text-[10px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

function ProblemCard({ problem }: { problem: BiProblem }) {
  const examples = Array.isArray(problem.evidence.examples)
    ? (problem.evidence.examples as unknown[]).filter((e): e is string => typeof e === "string")
    : [];
  return (
    <li className="rounded-xl border border-line px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-ink">
          <span
            className={
              "mr-2 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider " +
              (SEVERITY_STYLE[problem.severity] ?? SEVERITY_STYLE.info)
            }
          >
            {problem.severity === "critical" ? "Fix now" : "Worth a look"}
          </span>
          {problem.title}
        </p>
        <span className="text-[10px] text-ink-3">confidence {pct(problem.confidence)}</span>
      </div>
      <p className="mt-1.5 text-xs text-ink-2">{problem.impact}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Evidence</p>
          <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink-3">
            {evidenceLines(problem.evidence).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        {examples.length > 0 ? (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3">Customers said</p>
            <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink-3">
              {examples.slice(0, 3).map((example) => (
                <li key={example}>{"\u201c"}{example}{"\u201d"}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <a
        href={problem.action.href}
        className="mt-3 inline-block rounded-xl border border-brand/25 bg-brand-soft px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand-soft"
      >
        {problem.action.label} {"\u2192"}
      </a>
    </li>
  );
}

export default function InsightsClient() {
  const [days, setDays] = useState<7 | 30>(7);
  const [report, setReport] = useState<BiReport | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoaded(false);
    try {
      const response = await fetch("/api/omniflow/portal/bi/report?days=" + days, {
        credentials: "same-origin",
        cache: "no-store",
      });
      setReport(response.ok ? ((await response.json()) as BiReport) : null);
    } catch {
      setReport(null);
    } finally {
      setLoaded(true);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const rangeButtons = (
    <div className="flex gap-1.5">
      {([7, 30] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setDays(option)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            days === option
              ? "border-brand/30 bg-brand-soft text-brand"
              : "border-line bg-soft text-ink-3 hover:text-ink"
          }`}
        >
          Last {option} days
        </button>
      ))}
    </div>
  );

  if (!loaded) {
    return (
      <div className="space-y-3" aria-busy="true">
        {rangeButtons}
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="h-32 animate-pulse rounded-2xl bg-soft" />
        ))}
      </div>
    );
  }
  if (!report) {
    return (
      <div className="space-y-3">
        {rangeButtons}
        <p className="rounded-2xl border border-line bg-soft p-5 text-sm text-ink-3">
          Insights are unavailable right now. Try again shortly.
        </p>
      </div>
    );
  }

  const topics = report.insights.topics;
  const mix = report.insights.mix;
  const gaps = report.insights.gaps;
  const commerce = report.insights.commerce;
  const checkout = report.insights.checkout;
  const deliveries = report.insights.deliveries;
  const service = report.insights.service;
  const traces = report.ai_quality.traces;
  const resolution = report.ai_quality.resolution;
  const handoffs = report.ai_quality.handoffs;
  const usage = report.ai_quality.usage;
  const funnel = report.funnel;
  const maxTopic = topics ? Math.max(1, ...topics.topics.map((t) => t.count)) : 1;

  return (
    <div className="space-y-4">
      {rangeButtons}

      <Section
        title="Problems worth fixing"
        description="Detected from your own conversations, orders, deliveries and the assistant's decisions. Each one names its evidence and the next step."
        aside={
          <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-3">
            {report.problem_counts.critical} to fix now {"\u00b7"} {report.problem_counts.warn} worth a look
          </span>
        }
      >
        {report.problems.length === 0 ? (
          <p className="mt-3 text-xs text-ink-3">
            Nothing stands out in this window. Problems appear here once there is
            enough data to be sure, never on a handful of messages.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {report.problems.map((problem) => (
              <ProblemCard key={problem.key} problem={problem} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="What customers talk about"
        description="Every inbound message is matched against delivery, price, availability, payment, returns, complaint, order-status and location topics."
      >
        {!topics || topics.messages === 0 ? (
          <p className="mt-3 text-xs text-ink-3">No inbound messages in this window.</p>
        ) : (
          <>
            <p className="mt-3 text-[11px] text-ink-3">
              {topics.messages} messages from {topics.conversations} conversations
              {topics.previous_messages > 0 ? " \u00b7 trend vs the previous " + days + " days" : ""}
              {topics.busy_hours.length > 0
                ? " \u00b7 busiest hours " +
                  topics.busy_hours.map((h) => hourLabel(h.hour)).join(", ")
                : ""}
            </p>
            <ul className="mt-3 space-y-2">
              {topics.topics
                .filter((topic) => topic.count > 0)
                .map((topic) => (
                  <li key={topic.key}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-ink">
                        {topic.label}
                        <span className="ml-1.5 text-[10px] text-ink-3">
                          {trendGlyph(topic.trend)} {topic.trend}
                        </span>
                      </span>
                      <span className="text-ink-3">
                        {pct(topic.share)} {"\u00b7"} {topic.count} messages {"\u00b7"} {topic.conversations} chats
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft">
                      <div
                        className="h-full rounded-full bg-brand/50"
                        style={{ width: Math.max(4, Math.round((topic.count / maxTopic) * 100)) + "%" }}
                      />
                    </div>
                    {topic.examples.length > 0 ? (
                      <p className="mt-0.5 truncate text-[10px] text-ink-3">
                        {"\u201c"}{topic.examples[0]}{"\u201d"}
                      </p>
                    ) : null}
                  </li>
                ))}
            </ul>
          </>
        )}
        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <Stat
            label="Negative tone"
            value={mix ? pct(mix.negative_share) : "\u2014"}
            hint={mix ? mix.conversations + " conversations analysed" : undefined}
          />
          <Stat
            label="Ready to buy"
            value={mix ? pct(mix.high_purchase_share) : "\u2014"}
            hint="high purchase intent"
          />
          <Stat
            label="Unanswered questions"
            value={gaps ? String(gaps.count) : "\u2014"}
            hint={gaps && gaps.top_topics.length ? "mostly " + gaps.top_topics[0].label.toLowerCase() : "knowledge gaps"}
          />
          <Stat
            label="Waiting over SLA"
            value={service ? String(service.overdue_replies) : "\u2014"}
            hint={service ? "open chats past " + service.overdue_hours + "h" : undefined}
          />
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <Stat
            label="COD declined"
            value={commerce ? pct(commerce.cod.decline_share) : "\u2014"}
            hint={commerce ? commerce.cod.confirmed + " confirmed / " + commerce.cod.declined + " declined" : undefined}
          />
          <Stat
            label="Checkout links paid"
            value={checkout ? pct(checkout.conversion) : "\u2014"}
            hint={checkout ? checkout.paid + " of " + checkout.created : undefined}
          />
          <Stat
            label="Delivery problems"
            value={deliveries ? pct(deliveries.problem_share) : "\u2014"}
            hint={deliveries ? deliveries.problem_bookings + " of " + deliveries.bookings + " bookings" : undefined}
          />
          <Stat
            label="Satisfaction"
            value={service && service.csat_avg !== null ? service.csat_avg + " / 5" : "\u2014"}
            hint={service ? service.csat_answers + " ratings" : undefined}
          />
        </div>
      </Section>

      <Section
        title="AI quality"
        description="How the assistant decided, how often it needed a person, how grounded its answers were, and what it could not answer."
      >
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <Stat
            label="Decisions"
            value={traces ? String(traces.decisions) : "\u2014"}
            hint={traces ? traces.auto_answers + " live answers \u00b7 " + traces.drafts + " drafts" : undefined}
          />
          <Stat
            label="Handoff rate"
            value={traces ? pct(traces.handoff_share) : "\u2014"}
            hint={
              traces && Object.keys(traces.reasons).length
                ? Object.entries(traces.reasons)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 2)
                    .map(([k, v]) => (REASON_LABEL[k] ?? k) + " " + v)
                    .join(" \u00b7 ")
                : undefined
            }
          />
          <Stat
            label="Resolved by AI"
            value={resolution ? pct(resolution.resolved_share) : "\u2014"}
            hint={
              resolution
                ? resolution.answered_conversations + " answered \u00b7 " + resolution.escalated_after + " later handed off"
                : undefined
            }
          />
          <Stat
            label="Grounded answers"
            value={traces ? pct(traces.grounded_share) : "\u2014"}
            hint={traces ? pct(traces.cited_share) + " cited a document" : undefined}
          />
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <Stat
            label="Avg confidence"
            value={traces && traces.avg_confidence !== null ? traces.avg_confidence.toFixed(2) : "\u2014"}
          />
          <Stat
            label="Handoffs"
            value={handoffs ? String(handoffs.current) : "\u2014"}
            hint={
              handoffs
                ? (handoffs.growth === null ? "no previous window" : pct(handoffs.growth) + " vs previous") +
                  " \u00b7 " + handoffs.open + " open"
                : undefined
            }
          />
          <Stat
            label="AI engine"
            value={usage ? usage.calls + " calls" : "\u2014"}
            hint={usage ? pct(usage.failed_share) + " failed \u00b7 " + usage.avg_latency_ms + " ms avg" : undefined}
          />
          <Stat
            label="CSAT after AI"
            value={resolution && resolution.csat_after_ai !== null ? resolution.csat_after_ai + " / 5" : "\u2014"}
            hint={resolution ? resolution.csat_after_ai_n + " ratings" : undefined}
          />
        </div>
        {handoffs && handoffs.reasons.length > 0 ? (
          <p className="mt-3 text-[11px] text-ink-3">
            Top handoff reasons:{" "}
            {handoffs.reasons
              .map((r) => r.label + " (" + (SOURCE_LABEL[r.source] ?? r.source) + ", " + r.count + ")")
              .join(" \u00b7 ")}
          </p>
        ) : null}
        {report.ai_quality.unanswered.examples.length > 0 ? (
          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-wider text-ink-3">
              Questions it could not answer ({report.ai_quality.unanswered.count})
            </p>
            <ul className="mt-1 space-y-0.5 text-[11px] text-ink-3">
              {report.ai_quality.unanswered.examples.map((example) => (
                <li key={example}>{"\u201c"}{example}{"\u201d"}</li>
              ))}
            </ul>
            <a href="/dashboard/knowledge-base" className="mt-2 inline-block text-[11px] text-brand hover:underline">
              Teach the assistant {"\u2192"}
            </a>
          </div>
        ) : null}
      </Section>

      <Section
        title="Customer journey"
        description="Your journey stages: who is where now, who reached each stage in the window, how they convert and where they stall."
      >
        {!funnel || !funnel.configured ? (
          <p className="mt-3 text-xs text-ink-3">
            No journey stages yet. Define them on a customer profile (Journey card) and the
            funnel appears here.{" "}
            <a href="/dashboard/customers" className="text-brand hover:underline">
              Open customers {"\u2192"}
            </a>
          </p>
        ) : (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <Stat label="Customers in a stage" value={String(funnel.contacts)} />
              <Stat
                label="Reached the last stage"
                value={String(funnel.reached_last)}
                hint={funnel.overall_conversion !== null ? pct(funnel.overall_conversion) + " of those who entered" : undefined}
              />
              <Stat label="Stage moves" value={String(funnel.events)} hint={"last " + funnel.days * 2 + " days sampled"} />
              <Stat
                label="Stalled"
                value={String(funnel.stalled)}
                hint={"no move in " + funnel.stall_days + " days"}
              />
            </div>
            <ol className="mt-3 space-y-1.5">
              {funnel.stages.map((stage) => (
                <li key={stage.name} className="rounded-xl border border-line px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <span className="text-ink">
                      {stage.position + 1}. {stage.name}
                    </span>
                    <span className="text-ink-3">
                      {stage.current} now {"\u00b7"} {stage.reached} reached
                      {stage.conversion_from_previous !== null
                        ? " \u00b7 " + pct(stage.conversion_from_previous) + " from previous"
                        : ""}
                      {stage.median_hours_to_next !== null
                        ? " \u00b7 " + stage.median_hours_to_next + "h to move on"
                        : ""}
                      {stage.stalled > 0 ? " \u00b7 " + stage.stalled + " stalled" : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft">
                    <div
                      className="h-full rounded-full bg-brand/50"
                      style={{
                        width:
                          Math.max(
                            4,
                            Math.round((stage.reached / Math.max(1, funnel.reached_first)) * 100)
                          ) + "%",
                      }}
                    />
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </Section>

      <p className="text-[10px] text-ink-3">
        Generated {new Date(report.generated_at).toLocaleString()} from your workspace data. No AI calls were used.
      </p>
    </div>
  );
}
