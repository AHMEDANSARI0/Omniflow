"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";

/**
 * Admin -> AI Control Center: every workspace's AI posture (autonomy,
 * agents, LLM usage + estimated cost, answers vs handoffs, escalations,
 * approvals) plus the platform controls the brain and every LLM call
 * obey (kill switch, autonomy cap, daily call cap) and a per-workspace
 * autonomy override (audited, owner notified).
 */

type Autonomy = "off" | "suggest" | "auto";
type GuardMode = "off" | "standard" | "strict";

const GUARD_LABEL: Record<GuardMode, string> = {
  off: "Off - record attempts only",
  standard: "Standard - block clear manipulation attempts",
  strict: "Strict - also hand off borderline messages",
};

interface Controls {
  kill_switch: boolean;
  autonomy_cap: Autonomy;
  daily_call_cap: number;
  guard_mode?: GuardMode;
  source: "panel" | "env" | "default";
}

interface Workspace {
  client_id: number;
  name: string;
  owner: string;
  email: string;
  users: number;
  autonomy: Autonomy;
  autonomy_updated_at: string | null;
  agents_active: number;
  agents_total: number;
  agents_draft_only: number;
  calls: number;
  failed: number;
  tokens: number;
  cost_usd: number | null;
  last_call_at: string | null;
  open_escalations: number;
  pending_approvals: number;
  answers: number;
  handoffs: number;
  blocked?: number;
}

interface Totals {
  workspaces: number;
  auto: number;
  suggest: number;
  off: number;
  agents_active: number;
  calls: number;
  failed: number;
  tokens: number;
  cost_usd: number;
  priced: boolean;
  open_escalations: number;
  pending_approvals: number;
  answers: number;
  handoffs: number;
  blocked?: number;
}

interface Recent {
  id: number;
  client_id: number;
  action: string;
  category: string;
  actor_kind: string;
  conversation_id: number | null;
  note: string;
  created_at: string | null;
}

interface Overview {
  days: number;
  generated_at: string;
  controls: Controls;
  totals: Totals;
  workspaces: Workspace[];
  recent: Recent[];
}

interface EvalCase {
  id: string;
  category: string;
  label: string;
  passed: boolean;
  detail: string;
}

interface LiveQualitySignal {
  key: string;
  severity: string;
  title: string;
  detail: string;
}

interface LiveQuality {
  days: number;
  scope?: string;
  traces?: {
    total?: number;
    by_decision?: Record<string, number>;
    avg_confidence?: number | null;
    grounded_share?: number | null;
    guard_blocked?: number;
  };
  usage?: {
    calls?: number;
    failed?: number;
    fail_share?: number | null;
    avg_latency_ms?: number;
  } | null;
  signals?: LiveQualitySignal[];
}

interface BehavioralEval {
  suite: string;
  version: string;
  mode: string;
  llm_calls: number;
  customer_data: boolean;
  passed: number;
  total: number;
  score: number;
  status: string;
  failed: string[];
  cases: EvalCase[];
}

const AUTONOMY_LABEL: Record<Autonomy, string> = {
  off: "Off",
  suggest: "Suggest",
  auto: "Auto",
};

const inputClass =
  "w-full rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors focus:border-brand/40";

function formatDate(value: string | null) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCost(value: number | null, priced: boolean) {
  if (!priced || value === null) return "not priced";
  return "$" + value.toFixed(value >= 10 ? 2 : 4);
}

function workspaceLabel(ws: Workspace) {
  return ws.name || ws.owner || ws.email || "Workspace " + ws.client_id;
}

function AutonomyChip({ level }: { level: Autonomy }) {
  const tone =
    level === "auto"
      ? "border-emerald-400/30 bg-emerald-400/10 text-ok"
      : level === "suggest"
      ? "border-brand/25 bg-brand-soft text-brand"
      : "border-line bg-soft text-ink-3";
  return (
    <span
      className={
        "rounded-full border px-2 py-0.5 text-[11px] font-medium " + tone
      }
    >
      {AUTONOMY_LABEL[level]}
    </span>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-white shadow-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-ink-3">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

export default function AdminAiControlPage() {
  const [days, setDays] = useState<7 | 30>(7);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [behavioralEval, setBehavioralEval] = useState<BehavioralEval | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [liveQuality, setLiveQuality] = useState<LiveQuality | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualityError, setQualityError] = useState<string | null>(null);

  // platform controls form
  const [killSwitch, setKillSwitch] = useState(false);
  const [autonomyCap, setAutonomyCap] = useState<Autonomy>("auto");
  const [dailyCap, setDailyCap] = useState("");
  const [guardMode, setGuardMode] = useState<GuardMode>("standard");
  const [savingControls, setSavingControls] = useState(false);

  // per-workspace override
  const [busyClient, setBusyClient] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        "/api/omniflow/admin/ai/overview?days=" + days,
        { credentials: "same-origin", cache: "no-store" }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          payload?.error?.message ??
            "Could not load the AI overview. Please try again."
        );
        setOverview(null);
      } else {
        const data = payload as Overview;
        setOverview(data);
        setKillSwitch(Boolean(data.controls?.kill_switch));
        setAutonomyCap(data.controls?.autonomy_cap ?? "auto");
        setDailyCap(
          data.controls?.daily_call_cap ? String(data.controls.daily_call_cap) : ""
        );
        setGuardMode(data.controls?.guard_mode ?? "standard");
      }
    } catch {
      setError("Network error — please try again.");
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  const runBehavioralEval = useCallback(async () => {
    setEvalLoading(true);
    setEvalError(null);
    try {
      const response = await fetch("/api/omniflow/admin/ai/eval", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setEvalError(
          payload?.error?.message ??
            "Could not run the AI behavioral checks. Please try again."
        );
        setBehavioralEval(null);
      } else {
        setBehavioralEval(payload as BehavioralEval);
      }
    } catch {
      setEvalError("Network error — behavioral checks were not completed.");
      setBehavioralEval(null);
    } finally {
      setEvalLoading(false);
    }
  }, []);

  const runLiveQuality = useCallback(async () => {
    setQualityLoading(true);
    setQualityError(null);
    try {
      const response = await fetch("/api/omniflow/admin/ai/quality?days=7", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setQualityError(
          (payload && payload.error && payload.error.message) ||
            "Could not sample live AI quality."
        );
        setLiveQuality(null);
      } else {
        setLiveQuality(payload as LiveQuality);
      }
    } catch {
      setQualityError("Network error — live quality was not sampled.");
      setLiveQuality(null);
    } finally {
      setQualityLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void runBehavioralEval();
    void runLiveQuality();
  }, [load, runBehavioralEval, runLiveQuality]);

  function flash(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 3200);
  }

  async function saveControls() {
    setSavingControls(true);
    setError(null);
    try {
      const response = await fetch("/api/omniflow/admin/providers", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group: "ai",
          values: {
            kill_switch: killSwitch ? "on" : "off",
            autonomy_cap: autonomyCap,
            daily_call_cap: dailyCap.trim(),
            guard_mode: guardMode,
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Could not save the controls.");
      } else {
        flash("Platform AI controls saved.");
        await load();
      }
    } catch {
      setError("Network error — controls were not saved.");
    } finally {
      setSavingControls(false);
    }
  }

  async function overrideAutonomy(ws: Workspace, next: Autonomy) {
    if (next === ws.autonomy) return;
    const reason = window.prompt(
      "Set AI autonomy for \"" +
        workspaceLabel(ws) +
        "\" to " +
        AUTONOMY_LABEL[next] +
        ".\n\nReason (shown to the workspace owner, optional):",
      ""
    );
    if (reason === null) return;
    setBusyClient(ws.client_id);
    setError(null);
    try {
      const response = await fetch(
        "/api/omniflow/admin/ai/clients/" + ws.client_id + "/autonomy",
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autonomy: next, reason: reason.trim() }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Could not update autonomy.");
      } else {
        flash(
          "Autonomy for " + workspaceLabel(ws) + " set to " +
            AUTONOMY_LABEL[next] + ". The owner has been notified."
        );
        await load();
      }
    } catch {
      setError("Network error — autonomy was not updated.");
    } finally {
      setBusyClient(null);
    }
  }

  const totals = overview?.totals;
  const controls = overview?.controls;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            AI Control Center
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            Every workspace&apos;s AI posture, platform-wide controls and
            audited overrides (Control Plane).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-line bg-white shadow-card p-0.5 text-xs">
            {([7, 30] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDays(option)}
                className={
                  "rounded-lg px-3 py-1.5 font-medium transition-colors " +
                  (days === option
                    ? "bg-white text-ink shadow-sm"
                    : "text-ink-3 hover:text-ink")
                }
              >
                {option} days
              </button>
            ))}
          </div>
          <button
            onClick={() => void runBehavioralEval()}
            disabled={evalLoading}
            className="rounded-xl border border-brand/25 bg-brand-soft px-3.5 py-2 text-xs font-medium text-brand transition-colors hover:border-brand/40 disabled:opacity-50"
          >
            {evalLoading ? "Running checks..." : "Run behavior checks"}
          </button>
          <button
            onClick={() => void load()}
            className="rounded-xl border border-line bg-white shadow-card px-3.5 py-2 text-xs font-medium text-ink-2 transition-colors hover:border-brand/40"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <motion.p
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          role="alert"
          className="mb-4 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-danger"
        >
          {error}
        </motion.p>
      )}
      {notice && (
        <motion.p
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] px-3 py-2 text-xs text-ok"
        >
          {notice}
        </motion.p>
      )}

      {controls?.kill_switch ? (
        <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-700">
          AI answering is paused platform-wide. No LLM call is made for any
          workspace until the pause is lifted below.
        </div>
      ) : null}

      {/* ---------- deterministic behavioral evaluation ---------- */}
      <div className="mb-6 rounded-2xl border border-line bg-white shadow-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              AI behavioral evaluation
            </h2>
            <p className="mt-1 max-w-2xl text-xs text-ink-3">
              Deploy-time contracts for injection defense, grounding,
              knowledge ranking, permissions, workflows and channel
              normalization. Deterministic only: no provider calls, customer
              data or usage cost.
            </p>
          </div>
          {behavioralEval ? (
            <span
              className={
                "rounded-full border px-2.5 py-1 text-xs font-medium " +
                (behavioralEval.status === "pass"
                  ? "border-emerald-400/30 bg-emerald-400/10 text-ok"
                  : "border-red-400/30 bg-red-400/10 text-danger")
              }
            >
              {behavioralEval.status === "pass" ? "All contracts pass" : "Review failed contracts"}
            </span>
          ) : null}
        </div>
        {evalError ? (
          <p className="mt-3 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-danger">
            {evalError}
          </p>
        ) : behavioralEval ? (
          <div className="mt-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {behavioralEval.score.toFixed(1)}%
                </p>
                <p className="text-[11px] text-ink-3">
                  {behavioralEval.passed} of {behavioralEval.total} contracts ·
                  version {behavioralEval.version}
                </p>
              </div>
              <p className="text-[11px] text-ink-3">
                {behavioralEval.llm_calls} LLM calls · customer data: {behavioralEval.customer_data ? "yes" : "no"}
              </p>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {behavioralEval.cases.map((item) => (
                <div
                  key={item.id}
                  className={
                    "rounded-lg border px-3 py-2 text-xs " +
                    (item.passed
                      ? "border-emerald-400/20 bg-emerald-400/[0.04]"
                      : "border-red-400/25 bg-red-400/[0.05]")
                  }
                >
                  <p className="font-medium text-ink">
                    {item.passed ? "Pass" : "Fail"} · {item.label}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink-3">{item.category}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs text-ink-3">
            {evalLoading ? "Running deterministic contracts..." : "No result yet."}
          </p>
        )}
      </div>


      {/* ---------- live provider quality sample ---------- */}
      <div className="mb-6 rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Live provider quality</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">
              Deterministic sample of recent brain traces and LLM usage across
              workspaces. Zero extra provider cost. Owner labelled sets live on
              Configure AI.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runLiveQuality()}
            disabled={qualityLoading}
            className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-line-2 disabled:opacity-50"
          >
            {qualityLoading ? "Sampling..." : "Refresh sample"}
          </button>
        </div>
        {qualityError ? (
          <p className="mt-3 text-xs text-danger">{qualityError}</p>
        ) : liveQuality ? (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-line bg-canvas px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-ink-3">Traces</p>
                <p className="text-lg font-semibold text-ink">
                  {liveQuality.traces?.total ?? 0}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-canvas px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-ink-3">Avg confidence</p>
                <p className="text-lg font-semibold text-ink">
                  {liveQuality.traces?.avg_confidence == null
                    ? "—"
                    : Math.round((liveQuality.traces.avg_confidence || 0) * 100) + "%"}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-canvas px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-ink-3">LLM calls</p>
                <p className="text-lg font-semibold text-ink">
                  {liveQuality.usage?.calls ?? "—"}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-canvas px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-ink-3">Fail share</p>
                <p className="text-lg font-semibold text-ink">
                  {liveQuality.usage?.fail_share == null
                    ? "—"
                    : Math.round((liveQuality.usage.fail_share || 0) * 100) + "%"}
                </p>
              </div>
            </div>
            {(liveQuality.signals || []).length > 0 ? (
              <ul className="space-y-1.5">
                {(liveQuality.signals || []).map((s) => (
                  <li key={s.key + s.title} className="text-xs text-ink-2">
                    <span className="font-medium text-ink">{s.title}</span>
                    {" · "}
                    {s.detail}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-3">
                No elevated signals in the last {liveQuality.days} days.
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink-3">
            {qualityLoading ? "Sampling live quality..." : "No sample yet."}
          </p>
        )}
      </div>

      {/* ---------- platform controls ---------- */}
      <div className="mb-6 rounded-2xl border border-line bg-white shadow-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Platform controls</h2>
            <p className="mt-1 text-xs text-ink-3">
              Applied on top of every workspace&apos;s own setting. Source:{" "}
              {controls?.source ?? "default"}
              {controls?.source === "env"
                ? " (OF_AI_* environment variables; saving here takes precedence)"
                : ""}
              .
            </p>
          </div>
          <button
            type="button"
            onClick={() => void saveControls()}
            disabled={savingControls || loading}
            className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
          >
            {savingControls ? "Saving…" : "Save controls"}
          </button>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <label className="flex items-start gap-2 rounded-xl border border-line bg-canvas px-3.5 py-3 text-sm text-ink-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={killSwitch}
              onChange={(event) => setKillSwitch(event.target.checked)}
            />
            <span>
              <span className="block font-medium text-ink">
                Pause all AI answering
              </span>
              <span className="block text-[11px] text-ink-3">
                Kill switch: the Business Brain stops answering and drafting,
                workflow AI decisions and every other LLM call return
                &quot;unavailable&quot;. Human replies are unaffected.
              </span>
            </span>
          </label>
          <div>
            <label
              htmlFor="ai_autonomy_cap"
              className="mb-1 block text-xs font-medium text-ink-3"
            >
              Highest autonomy any workspace may run at
            </label>
            <select
              id="ai_autonomy_cap"
              value={autonomyCap}
              onChange={(event) => setAutonomyCap(event.target.value as Autonomy)}
              className={inputClass}
            >
              {(Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((level) => (
                <option key={level} value={level}>
                  {AUTONOMY_LABEL[level]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-ink-3">
              A workspace set to Auto runs at Suggest while the cap is Suggest.
            </p>
          </div>
          <div>
            <label
              htmlFor="ai_daily_cap"
              className="mb-1 block text-xs font-medium text-ink-3"
            >
              Daily LLM calls per workspace (blank = unlimited)
            </label>
            <input
              id="ai_daily_cap"
              value={dailyCap}
              onChange={(event) =>
                setDailyCap(event.target.value.replace(/[^0-9]/g, ""))
              }
              inputMode="numeric"
              placeholder="e.g. 2000"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-ink-3">
              Rolling 24 hours. The owner is notified once a day when reached.
            </p>
          </div>
          <div>
            <label
              htmlFor="ai_guard_mode"
              className="mb-1 block text-xs font-medium text-ink-3"
            >
              Prompt-injection guard
            </label>
            <select
              id="ai_guard_mode"
              value={guardMode}
              onChange={(event) => setGuardMode(event.target.value as GuardMode)}
              className={inputClass}
            >
              {(Object.keys(GUARD_LABEL) as GuardMode[]).map((level) => (
                <option key={level} value={level}>
                  {GUARD_LABEL[level]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-ink-3">
              Messages that try to rewrite the assistant&apos;s instructions are
              handed to a human instead of the model. Blocked attempts appear
              in each workspace&apos;s AI activity under Security.
            </p>
          </div>
        </div>
      </div>

      {/* ---------- totals ---------- */}
      {totals ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Workspaces"
            value={formatNumber(totals.workspaces)}
            hint={
              totals.auto + " auto · " + totals.suggest + " suggest · " +
              totals.off + " off"
            }
          />
          <Tile
            label={"LLM calls (" + overview?.days + "d)"}
            value={formatNumber(totals.calls)}
            hint={formatNumber(totals.failed) + " failed"}
          />
          <Tile
            label="Tokens · estimated cost"
            value={formatNumber(totals.tokens)}
            hint={formatCost(totals.cost_usd, totals.priced)}
          />
          <Tile
            label="Brain answers · handoffs"
            value={formatNumber(totals.answers) + " · " + formatNumber(totals.handoffs)}
            hint={
              formatNumber(totals.agents_active) +
              " active agents · " +
              formatNumber(totals.blocked ?? 0) +
              " injection attempts blocked"
            }
          />
          <Tile
            label="Open escalations"
            value={formatNumber(totals.open_escalations)}
          />
          <Tile
            label="Pending approvals"
            value={formatNumber(totals.pending_approvals)}
          />
        </div>
      ) : null}

      {/* ---------- workspaces ---------- */}
      <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">Workspaces</h2>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Changing autonomy here is recorded as a platform-admin action and
            the workspace owner is notified.
          </p>
        </div>
        {loading && !overview ? (
          <div className="px-5 py-10 text-center text-sm text-ink-3">
            Loading AI overview…
          </div>
        ) : !overview || overview.workspaces.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-3">
            No workspaces found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-ink-3">
                  <th className="px-4 py-3 font-medium">Workspace</th>
                  <th className="px-4 py-3 font-medium">Autonomy</th>
                  <th className="px-4 py-3 font-medium">Agents</th>
                  <th className="px-4 py-3 font-medium">Calls · failed</th>
                  <th className="px-4 py-3 font-medium">Cost</th>
                  <th className="px-4 py-3 font-medium">Answers · handoffs · blocked</th>
                  <th className="px-4 py-3 font-medium">Escalations · approvals</th>
                  <th className="px-4 py-3 font-medium">Last AI call</th>
                </tr>
              </thead>
              <tbody>
                {overview.workspaces.map((ws) => (
                  <tr
                    key={ws.client_id}
                    className="border-b border-line last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">
                        {workspaceLabel(ws)}
                      </div>
                      <div className="text-[11px] text-ink-3">
                        #{ws.client_id}
                        {ws.email ? " · " + ws.email : ""}
                        {ws.users ? " · " + ws.users + " user" + (ws.users === 1 ? "" : "s") : ""}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <AutonomyChip level={ws.autonomy} />
                        <select
                          aria-label={"Autonomy for " + workspaceLabel(ws)}
                          value={ws.autonomy}
                          disabled={busyClient === ws.client_id}
                          onChange={(event) =>
                            void overrideAutonomy(
                              ws,
                              event.target.value as Autonomy
                            )
                          }
                          className="rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink-2 disabled:opacity-50"
                        >
                          {(Object.keys(AUTONOMY_LABEL) as Autonomy[]).map(
                            (level) => (
                              <option key={level} value={level}>
                                {AUTONOMY_LABEL[level]}
                              </option>
                            )
                          )}
                        </select>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {ws.agents_active}
                      {ws.agents_draft_only
                        ? " (" + ws.agents_draft_only + " drafts only)"
                        : ""}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {formatNumber(ws.calls)} · {formatNumber(ws.failed)}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {formatCost(ws.cost_usd, totals?.priced ?? false)}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {formatNumber(ws.answers)} · {formatNumber(ws.handoffs)} ·{" "}
                      {formatNumber(ws.blocked ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {ws.open_escalations} · {ws.pending_approvals}
                    </td>
                    <td className="px-4 py-3 text-ink-3">
                      {formatDate(ws.last_call_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- recent AI activity ---------- */}
      <div className="mt-6 rounded-2xl border border-line bg-white shadow-card p-5">
        <h2 className="text-sm font-semibold text-ink">
          Recent AI activity (all workspaces)
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-3">
          Automation, brain, workflow and system entries from the audit log.
        </p>
        {!overview || overview.recent.length === 0 ? (
          <p className="mt-3 text-xs text-ink-3">No AI activity in this window.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {overview.recent.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 py-2 text-xs">
                <span className="w-32 shrink-0 text-ink-3">
                  {formatDate(entry.created_at)}
                </span>
                <span className="w-20 shrink-0 text-ink-3">#{entry.client_id}</span>
                <span className="min-w-0 flex-1 text-ink-2">
                  <span className="font-medium text-ink">{entry.action}</span>
                  <span className="text-ink-3"> · {entry.category}</span>
                  {entry.note ? (
                    <span className="block truncate text-ink-3">{entry.note}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {overview ? (
        <p className="mt-3 text-[11px] text-ink-3">
          Generated {formatDate(overview.generated_at)}. Costs are estimates
          from the model price table saved under Integrations → AI engine.
        </p>
      ) : null}
    </div>
  );
}
