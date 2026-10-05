"use client";

import { useCallback, useEffect, useState } from "react";
import type { RuleConflict, RuleConflictReport } from "../../../../lib/omniflow/portal";

const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 disabled:opacity-50";
const ghostBtn =
  "rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors duration-300 hover:border-line-2 hover:text-ink disabled:opacity-50";

const SEVERITY: Record<RuleConflict["severity"], { label: string; badge: string; border: string }> = {
  high: { label: "High", badge: "bg-danger-soft text-danger", border: "border-danger/30" },
  warn: { label: "Warning", badge: "bg-warn-soft text-warn", border: "border-warn/30" },
  info: { label: "Info", badge: "bg-soft text-ink-2", border: "border-line" },
};

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  const message = payload?.error?.message;
  return typeof message === "string" && message ? message : fallback;
}

/** §232: rules that fight each other, at the top of the Rules page. */
export default function RuleConflicts() {
  const [report, setReport] = useState<RuleConflictReport | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/omniflow/portal/policy/conflicts", { cache: "no-store" });
      if (response.ok) {
        setReport((await response.json()) as RuleConflictReport);
        setLoadError("");
      } else {
        setLoadError(await errorMessage(response, "Conflicts could not be checked. Try again."));
      }
    } catch {
      setLoadError("Network problem. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setIgnored(item: RuleConflict, ignored: boolean) {
    setBusyId(item.id);
    setActionError("");
    try {
      const response = await fetch("/api/omniflow/portal/policy/conflicts/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, ignored }),
      });
      if (response.ok) {
        await load();
      } else {
        setActionError(await errorMessage(response, "Could not save. Try again."));
      }
    } catch {
      setActionError("Network problem. Try again.");
    } finally {
      setBusyId("");
    }
  }

  async function checkWithAi() {
    setAiBusy(true);
    setAiNote("");
    setActionError("");
    try {
      const response = await fetch("/api/omniflow/portal/policy/conflicts/ai-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (response.ok) {
        const result = (await response.json()) as {
          checkedPairs: number;
          remainingPairs: number;
          findings: RuleConflict[];
        };
        const found = result.findings.length;
        setAiNote(
          "Checked " + result.checkedPairs + " answer pair" + (result.checkedPairs === 1 ? "" : "s") +
            ": " + (found ? found + " contradiction" + (found === 1 ? "" : "s") + " found." : "no contradictions.") +
            (result.remainingPairs ? " " + result.remainingPairs + " more pair(s) were not checked this time." : "")
        );
        await load();
      } else {
        setActionError(await errorMessage(response, "The AI check did not run. Try again."));
      }
    } catch {
      setActionError("Network problem. Try again.");
    } finally {
      setAiBusy(false);
    }
  }

  const findings = report?.findings ?? [];
  const visible = findings.filter((item) => showIgnored || !item.ignored);
  const open = findings.filter((item) => !item.ignored).length;
  const checked = report?.checked;
  const total = checked ? checked.routing + checked.workflows + checked.sequences + checked.kb + checked.facts : 0;

  return (
    <section className="mb-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Conflicts</h2>
          <p className="mt-1 max-w-2xl text-xs text-ink-2">
            Rules that fight each other: a rule that can never fire, two rules answering the same
            message, opposite instructions, or a chain that will not start.
          </p>
          {checked ? (
            <p className="mt-1 text-[11px] text-ink-3">
              Checked {checked.routing} routing rules, {checked.workflows} active workflows,{" "}
              {checked.sequences} series, {checked.kb} knowledge entries and {checked.facts} business facts.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {report ? (
            <>
              {report.counts.high ? (
                <span className="rounded-full bg-danger-soft px-2.5 py-1 text-[11px] font-medium text-danger">
                  {report.counts.high} high
                </span>
              ) : null}
              <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-medium text-warn">
                {report.counts.warn} warnings
              </span>
              <span className="rounded-full bg-soft px-2.5 py-1 text-[11px] font-medium text-ink-2">
                {report.counts.info} info
              </span>
            </>
          ) : null}
          <button type="button" className={ghostBtn} onClick={() => void load()} disabled={loading}>
            {loading ? "Checking..." : "Check again"}
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="mt-4 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {loadError}
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-4 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {actionError}
        </div>
      ) : null}
      {report === null && !loadError ? (
        <p className="mt-4 text-xs text-ink-3">Checking your rules...</p>
      ) : null}

      {report !== null && open === 0 ? (
        <div className="mt-4 rounded-xl border border-ok/30 bg-ok-soft px-3 py-2 text-xs text-ok">
          ✓ No conflicts found{total ? " across " + total + " rules" : ""}.
        </div>
      ) : null}

      {visible.length ? (
        <ul className="mt-4 space-y-3">
          {visible.map((item) => {
            const tone = SEVERITY[item.severity];
            return (
              <li
                key={item.id}
                className={"rounded-xl border p-4 " + tone.border + (item.ignored ? " bg-soft opacity-70" : " bg-white")}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={"rounded-full px-2 py-0.5 text-[11px] font-medium " + tone.badge}>
                        {tone.label}
                      </span>
                      <span className="text-sm font-semibold text-ink">{item.title}</span>
                      {item.ignored ? <span className="text-[11px] text-ink-3">Ignored</span> : null}
                    </div>
                    <p className="mt-1.5 text-xs text-ink-2">{item.detail}</p>
                    <p className="mt-1 text-xs text-ink">
                      <span className="font-medium">Fix: </span>
                      {item.fix}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.rules.map((rule) => (
                        <a
                          key={rule.type + ":" + rule.id}
                          href={rule.href}
                          className="rounded-lg border border-line bg-soft px-2 py-1 text-[11px] text-ink-2 transition-colors duration-300 hover:border-brand/40 hover:text-brand"
                        >
                          {rule.label || rule.type}
                        </a>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={ghostBtn}
                    disabled={busyId === item.id}
                    onClick={() => void setIgnored(item, !item.ignored)}
                  >
                    {item.ignored ? "Restore" : "Ignore"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {report && report.counts.ignored ? (
        <button
          type="button"
          className="mt-3 text-xs font-medium text-ink-2 underline-offset-2 hover:underline"
          onClick={() => setShowIgnored((value) => !value)}
        >
          {showIgnored ? "Hide ignored" : "Show ignored (" + report.counts.ignored + ")"}
        </button>
      ) : null}

      {report ? (
        <div className="mt-5 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Do your answers contradict each other?</p>
              <p className="mt-0.5 text-xs text-ink-2">
                {report.ai.candidates
                  ? report.ai.candidates + " knowledge / fact pair" + (report.ai.candidates === 1 ? "" : "s") +
                    " cover the same topic. The AI reads up to " + report.ai.pairsPerCheck +
                    " pairs per check and flags different numbers, days or policies."
                  : "No knowledge entries or facts overlap, so there is nothing to compare."}
              </p>
              {report.ai.checkedAt ? (
                <p className="mt-0.5 text-[11px] text-ink-3">
                  Last checked {new Date(report.ai.checkedAt).toLocaleString()} ({report.ai.checkedPairs} pairs).
                  Results drop by themselves when you edit an answer.
                </p>
              ) : null}
              {!report.ai.ready && report.ai.reason ? (
                <p className="mt-0.5 text-[11px] text-warn">{report.ai.reason}</p>
              ) : null}
            </div>
            <button
              type="button"
              className={primaryBtn}
              disabled={aiBusy || !report.ai.ready || report.ai.candidates === 0}
              onClick={() => void checkWithAi()}
            >
              <span className="mr-1.5">✶</span>
              {aiBusy ? "Checking..." : "Check answers with AI"}
            </button>
          </div>
          {aiNote ? <p className="mt-2 text-xs text-ink-2">{aiNote}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
