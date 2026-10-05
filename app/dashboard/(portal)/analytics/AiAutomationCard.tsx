"use client";

/** AI + automation quadrant; follows the Analytics window (days). */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AiAutomationView } from "../../../../lib/omniflow/portal";

const tile = "rounded-xl border border-line bg-soft px-3 py-2.5";
const tileLabel = "text-[10px] uppercase tracking-wider text-ink-3";
const tileValue = "mt-0.5 text-base font-semibold text-ink";
const heading = "text-xs font-semibold text-ink";
const muted = "text-xs text-ink-3";

function pct(value: number | null): string {
  return value === null ? "—" : Math.round(value * 100) + "%";
}

function money(value: number | null): string {
  if (value === null) return "—";
  return "$" + (value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2));
}

function when(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function Tile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className={tile}>
      <p className={tileLabel}>{label}</p>
      <p className={tileValue}>{value}</p>
      {note ? <p className="text-[10px] text-ink-3">{note}</p> : null}
    </div>
  );
}

function Unavailable({ what }: { what: string }) {
  return <p className={muted}>{what} numbers are not available for this workspace yet.</p>;
}

function AiQuadrant({ view }: { view: AiAutomationView }) {
  const { answers, usage, bands } = view.ai;
  const conf = answers.confidence;
  const scored = Math.max(1, conf.scored);
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-ink">AI</h3>
      {!answers.available ? (
        <Unavailable what="AI answer" />
      ) : answers.automatic + answers.drafts === 0 ? (
        <p className={muted}>No AI answers in this window yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Tile label="Automatic answers" value={answers.automatic} />
            <Tile label="Sent by the AI" value={answers.sent} note={pct(answers.sentShare)} />
            <Tile label="Handed to the team" value={answers.handedOff} />
          </div>
          <p className={muted}>
            {answers.drafts} {answers.drafts === 1 ? "draft" : "drafts"} for the team, {answers.draftsUsable} ready to
            send.
          </p>
          <div>
            <div className="flex items-baseline justify-between">
              <p className={heading}>Confidence</p>
              <p className={muted}>
                Avg confidence {conf.average === null ? "—" : Math.round(conf.average * 100) + "%"}
              </p>
            </div>
            {conf.scored === 0 ? (
              <p className={"mt-1 " + muted}>No scored answers yet.</p>
            ) : (
              <>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-soft">
                  <div className="bg-emerald-400" style={{ width: (conf.high / scored) * 100 + "%" }} />
                  <div className="bg-amber-400" style={{ width: (conf.ok / scored) * 100 + "%" }} />
                  <div className="bg-rose-400" style={{ width: (conf.low / scored) * 100 + "%" }} />
                </div>
                <p className={"mt-1 " + muted}>
                  {conf.high} high (from {Math.round(bands.highFrom * 100)}%) · {conf.ok} ok · {conf.low} low (below{" "}
                  {Math.round(bands.lowBelow * 100)}%)
                </p>
              </>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className={heading}>Tools the AI used</p>
              <ul className="mt-2 space-y-1">
                {answers.tools.map((tool) => (
                  <li key={tool.key} className="flex justify-between gap-3 text-xs">
                    <span className="truncate text-ink-2">{tool.label}</span>
                    <span className="shrink-0 text-ink-3">
                      {tool.count} · {pct(tool.share)}
                    </span>
                  </li>
                ))}
                <li className="flex justify-between gap-3 text-xs">
                  <span className="text-ink-3">No tool</span>
                  <span className="text-ink-3">{answers.noTool}</span>
                </li>
              </ul>
            </div>
            <div>
              <p className={heading}>Why it handed off</p>
              {answers.reasons.length === 0 ? (
                <p className={"mt-2 " + muted}>No handoffs in this window.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {answers.reasons.map((reason) => (
                    <li key={reason.reason} className="flex justify-between gap-3 text-xs">
                      <span className="truncate text-ink-2">{reason.label}</span>
                      <span className="shrink-0 text-ink-3">{reason.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {answers.agents.length > 0 ? (
            <div>
              <p className={heading}>By agent</p>
              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-3">
                    <th className="py-1 font-medium">Agent</th>
                    <th className="py-1 text-right font-medium">Answers</th>
                    <th className="py-1 text-right font-medium">Sent</th>
                    <th className="py-1 text-right font-medium">Conf.</th>
                    <th className="py-1 text-right font-medium">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {answers.agents.map((agent) => (
                    <tr key={agent.agentId ?? "default"} className="border-t border-line text-ink-2">
                      <td className="max-w-[10rem] truncate py-1">{agent.name}</td>
                      <td className="py-1 text-right">{agent.answers}</td>
                      <td className="py-1 text-right">{agent.sent}</td>
                      <td className="py-1 text-right">
                        {agent.avgConfidence === null ? "—" : Math.round(agent.avgConfidence * 100) + "%"}
                      </td>
                      <td className="py-1 text-right">
                        {agent.calls}
                        {agent.costUsd !== null ? " · " + money(agent.costUsd) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
      <div>
        <p className={heading}>AI engine</p>
        {!usage.available ? (
          <Unavailable what="AI engine" />
        ) : usage.calls === 0 ? (
          <p className={"mt-1 " + muted}>No AI calls in this window.</p>
        ) : (
          <p className={"mt-1 " + muted}>
            {usage.calls} calls · {usage.failed} failed ({pct(usage.failShare)}) ·{" "}
            {usage.tokens.toLocaleString()} tokens · {usage.avgLatencyMs} ms avg ·{" "}
            {usage.priced ? "estimated cost " + money(usage.costUsd) : "cost not shown (model prices are not set)"}
          </p>
        )}
      </div>
    </section>
  );
}

function AutomationQuadrant({ view }: { view: AiAutomationView }) {
  const { workflows, actions, sequences } = view.automation;
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-ink">Automation</h3>
      <div>
        <div className="flex items-baseline justify-between">
          <p className={heading}>Workflows</p>
          <Link href="/dashboard/workflows" className="text-xs text-brand hover:underline">
            Open workflows
          </Link>
        </div>
        {!workflows.available ? (
          <Unavailable what="Workflow" />
        ) : workflows.runs === 0 ? (
          <p className={"mt-1 " + muted}>No workflow runs in this window.</p>
        ) : (
          <>
            <div className="mt-2 grid grid-cols-4 gap-2">
              <Tile label="Workflow runs" value={workflows.runs} note={workflows.steps + " steps"} />
              <Tile label="Goals reached" value={workflows.goalReached} note={pct(workflows.goalShare)} />
              <Tile label="Failed" value={workflows.failed} note={pct(workflows.failureShare)} />
              <Tile
                label="In progress"
                value={workflows.inProgress + workflows.waitingApproval}
                note={workflows.waitingApproval + " waiting for approval"}
              />
            </div>
            <p className={"mt-1 " + muted}>
              {workflows.completed} completed · {workflows.stopped} stopped
            </p>
            <p className={"mt-3 " + heading}>Busiest workflows</p>
            <ul className="mt-1 space-y-1">
              {workflows.top.map((row) => (
                <li key={row.workflowId} className="flex justify-between gap-3 text-xs">
                  <span className="truncate text-ink-2">{row.name}</span>
                  <span className="shrink-0 text-ink-3">
                    {row.runs} runs · {row.goalReached} goals · {row.failed} failed
                  </span>
                </li>
              ))}
            </ul>
            {workflows.failures.length > 0 ? (
              <>
                <p className={"mt-3 " + heading}>Latest failures</p>
                <ul className="mt-1 space-y-1.5">
                  {workflows.failures.map((row) => (
                    <li key={row.runId} className="text-xs">
                      <span className="text-ink-2">{row.name}</span>
                      <span className="text-ink-3"> · {when(row.at)}</span>
                      <p className="truncate text-danger">{row.error || "No error text recorded."}</p>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
      </div>
      <div>
        <p className={heading}>Actions</p>
        {!actions.available ? (
          <Unavailable what="Action" />
        ) : actions.total === 0 ? (
          <p className={"mt-1 " + muted}>No actions in this window.</p>
        ) : (
          <div className="mt-1 space-y-0.5 text-xs text-ink-2">
            <p>
              {actions.total} actions · {actions.byOutcome.executed} done · {actions.byOutcome.approvalRequired} sent
              for approval · {actions.byOutcome.denied} denied · {actions.byOutcome.error} failed
              {actions.byOutcome.running ? " · " + actions.byOutcome.running + " running" : ""}
            </p>
            <p className="text-ink-3">
              Started by: AI {actions.byActor.ai} · workflows {actions.byActor.workflow} · approvals{" "}
              {actions.byActor.approval} · team {actions.byActor.person}
            </p>
          </div>
        )}
        {actions.available && view.days > actions.keptDays ? (
          <p className={"mt-1 " + muted}>Action history is kept for {actions.keptDays} days.</p>
        ) : null}
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <p className={heading}>Follow-up sequences</p>
          <Link href="/dashboard/sequences" className="text-xs text-brand hover:underline">
            Sequences
          </Link>
        </div>
        {!sequences.available ? (
          <Unavailable what="Sequence" />
        ) : sequences.enrolled + sequences.sent === 0 ? (
          <p className={"mt-1 " + muted}>No follow-ups in this window.</p>
        ) : (
          <p className={"mt-1 " + muted}>
            {sequences.enrolled} enrolled · {sequences.active} active · {sequences.completed} completed ·{" "}
            {sequences.stopped} stopped · {sequences.paused} paused · {sequences.sent} messages sent ·{" "}
            {sequences.skipped} skipped
          </p>
        )}
      </div>
    </section>
  );
}

export default function AiAutomationCard({ days }: { days: number }) {
  const [view, setView] = useState<AiAutomationView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetch("/api/omniflow/portal/analytics/ai-automation?days=" + String(days), {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as AiAutomationView | null;
        if (!response.ok || !payload || !payload.ai || !payload.automation) throw new Error("unavailable");
        setView(payload);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [days]);

  return (
    <div className="rounded-2xl border border-line bg-white p-5 shadow-card">
      <h2 className="text-sm font-semibold text-ink">AI &amp; automation</h2>
      <p className={"mt-0.5 " + muted}>What the AI and your automations did in the last {days} days.</p>
      <div className="mt-4">
        {failed ? (
          <p className={muted}>AI and automation numbers are unavailable right now. Try again shortly.</p>
        ) : !view ? (
          <p className={muted}>Loading&#8230;</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <AiQuadrant view={view} />
            <AutomationQuadrant view={view} />
          </div>
        )}
      </div>
    </div>
  );
}
