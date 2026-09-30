"use client";

import { useCallback, useEffect, useState } from "react";

type Decision = "send" | "handoff" | "draft";

interface Signal {
  key: string;
  severity: string;
  title: string;
  detail: string;
}

interface Quality {
  days: number;
  traces: {
    total: number;
    by_decision: Record<string, number>;
    avg_confidence: number | null;
    grounded_share: number | null;
    cited_share: number | null;
    guard_blocked: number;
    handoff_reasons: Record<string, number>;
  };
  usage: {
    calls: number;
    failed: number;
    fail_share: number | null;
    avg_latency_ms: number;
  } | null;
  signals: Signal[];
}

interface LabelItem {
  message: string;
  expected_decision: Decision;
  expected_keywords: string[];
  forbidden_phrases: string[];
  note: string;
}

interface LabelSet {
  id: number;
  name: string;
  notes: string;
  items: LabelItem[];
  item_count: number;
  is_active: boolean;
}

interface RunResult {
  mode: string;
  passed: number;
  total: number;
  score: number;
  status: string;
  llm_calls: number;
  results: {
    message: string;
    expected_decision: string;
    actual_decision: string | null;
    passed: boolean;
    detail: string;
    live_reply: string | null;
  }[];
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "\u2014";
  return Math.round(value * 100) + "%";
}

function severityClass(sev: string): string {
  if (sev === "critical") return "border-rose-400/30 bg-rose-400/[0.08] text-danger";
  if (sev === "warn") return "border-amber-400/30 bg-amber-400/[0.08] text-amber-700";
  return "border-line bg-soft text-ink-2";
}

const emptyItem = (): LabelItem => ({
  message: "",
  expected_decision: "send",
  expected_keywords: [],
  forbidden_phrases: [],
  note: "",
});

export default function AiQualityCard() {
  const [days, setDays] = useState(7);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [sets, setSets] = useState<LabelSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [item, setItem] = useState<LabelItem>(emptyItem());
  const [keywords, setKeywords] = useState("");
  const [forbidden, setForbidden] = useState("");
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [runLive, setRunLive] = useState(false);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [qRes, lRes] = await Promise.all([
        fetch("/api/omniflow/portal/ai/quality?days=" + days, {
          credentials: "same-origin",
          cache: "no-store",
        }),
        fetch("/api/omniflow/portal/ai/labels", {
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);
      if (qRes.ok) {
        setQuality((await qRes.json()) as Quality);
      }
      if (lRes.ok) {
        const payload = (await lRes.json()) as { sets?: LabelSet[] };
        setSets(
          (payload.sets ?? []).filter((s) => s.is_active !== false)
        );
      }
    } catch {
      // fail-soft
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSet() {
    if (!name.trim() || !item.message.trim()) {
      setNotice("Add a set name and at least one customer message.");
      return;
    }
    setSaving(true);
    setNotice("");
    const body = {
      name: name.trim(),
      notes: "",
      items: [
        {
          message: item.message.trim(),
          expected_decision: item.expected_decision,
          expected_keywords: keywords
            .split(/[,;|]/)
            .map((x) => x.trim())
            .filter(Boolean),
          forbidden_phrases: forbidden
            .split(/[,;|]/)
            .map((x) => x.trim())
            .filter(Boolean),
          note: item.note,
        },
      ],
    };
    try {
      const response = await fetch("/api/omniflow/portal/ai/labels", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setNotice(payload?.error?.message || "Could not save the label set.");
        return;
      }
      setName("");
      setItem(emptyItem());
      setKeywords("");
      setForbidden("");
      setNotice("Label set saved.");
      await load();
    } catch {
      setNotice("Could not save the label set.");
    } finally {
      setSaving(false);
    }
  }

  async function runSet(id: number) {
    setRunningId(id);
    setNotice("");
    setLastRun(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/ai/labels/" + id + "/run",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ include_live: runLive }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | RunResult
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setNotice(
          (payload as { error?: { message?: string } })?.error?.message ||
            "Could not run the label set."
        );
        return;
      }
      setLastRun(payload as RunResult);
      setNotice(
        "Scored " +
          (payload as RunResult).passed +
          " / " +
          (payload as RunResult).total +
          " (" +
          (payload as RunResult).score +
          "%)."
      );
    } catch {
      setNotice("Could not run the label set.");
    } finally {
      setRunningId(null);
    }
  }

  async function archiveSet(id: number) {
    try {
      await fetch("/api/omniflow/portal/ai/labels/" + id, {
        method: "DELETE",
        credentials: "same-origin",
      });
      await load();
    } catch {
      // ignore
    }
  }

  const traces = quality?.traces;
  const usage = quality?.usage;

  return (
    <section className="rounded-xl2 border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            Live quality and labelled sets
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Sample recent brain answers and provider calls (no extra LLM cost),
            then keep small human-labelled examples you can re-score anytime.
            Live provider runs are optional and use your normal AI budget.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value) || 7)}
            className="rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink outline-none"
          >
            {[1, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                Last {d}d
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-line-2"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && !quality ? (
        <p className="mt-4 text-xs text-ink-3">Loading quality sample...</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-ink-3">
              Brain decisions
            </p>
            <p className="mt-1 text-lg font-semibold text-ink">
              {traces?.total ?? 0}
            </p>
            <p className="text-[11px] text-ink-3">
              send {traces?.by_decision?.send ?? 0}
              {" \u00b7 "}handoff {traces?.by_decision?.handoff ?? 0}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-ink-3">
              Avg confidence
            </p>
            <p className="mt-1 text-lg font-semibold text-ink">
              {traces?.avg_confidence === null ||
              traces?.avg_confidence === undefined
                ? "\u2014"
                : Math.round((traces.avg_confidence || 0) * 100) + "%"}
            </p>
            <p className="text-[11px] text-ink-3">
              grounded {pct(traces?.grounded_share)}
              {" \u00b7 "}cited {pct(traces?.cited_share)}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-ink-3">
              Provider calls
            </p>
            <p className="mt-1 text-lg font-semibold text-ink">
              {usage?.calls ?? "\u2014"}
            </p>
            <p className="text-[11px] text-ink-3">
              fail {pct(usage?.fail_share)}
              {" \u00b7 "}
              {usage?.avg_latency_ms ?? 0} ms avg
            </p>
          </div>
          <div className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-ink-3">
              Guard blocks
            </p>
            <p className="mt-1 text-lg font-semibold text-ink">
              {traces?.guard_blocked ?? 0}
            </p>
            <p className="text-[11px] text-ink-3">prompt-injection defense</p>
          </div>
        </div>
      )}

      {quality?.signals && quality.signals.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {quality.signals.map((signal) => (
            <li
              key={signal.key + signal.title}
              className={
                "rounded-xl border px-3 py-2 text-xs " +
                severityClass(signal.severity)
              }
            >
              <p className="font-medium">{signal.title}</p>
              <p className="mt-0.5 opacity-90">{signal.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-6 border-t border-line pt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">
          Human-labelled answer sets
        </h3>
        <p className="mt-1 text-xs text-ink-3">
          Save a customer message with the decision you expect. Run checks with
          zero LLM cost (guard + policy), or enable a live provider pass.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-ink-2">
            <span className="mb-1 block text-ink-3">Set name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Refund policy checks"
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40"
            />
          </label>
          <label className="block text-xs text-ink-2">
            <span className="mb-1 block text-ink-3">Expected decision</span>
            <select
              value={item.expected_decision}
              onChange={(event) =>
                setItem((prev) => ({
                  ...prev,
                  expected_decision: event.target.value as Decision,
                }))
              }
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none"
            >
              <option value="send">send</option>
              <option value="handoff">handoff</option>
              <option value="draft">draft</option>
            </select>
          </label>
          <label className="block text-xs text-ink-2 sm:col-span-2">
            <span className="mb-1 block text-ink-3">Customer message</span>
            <textarea
              value={item.message}
              onChange={(event) =>
                setItem((prev) => ({ ...prev, message: event.target.value }))
              }
              rows={2}
              placeholder="Mujhe full refund chahiye kal tak."
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40"
            />
          </label>
          <label className="block text-xs text-ink-2">
            <span className="mb-1 block text-ink-3">
              Expected keywords (live run)
            </span>
            <input
              value={keywords}
              onChange={(event) => setKeywords(event.target.value)}
              placeholder="policy, 7 days"
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none"
            />
          </label>
          <label className="block text-xs text-ink-2">
            <span className="mb-1 block text-ink-3">Forbidden phrases</span>
            <input
              value={forbidden}
              onChange={(event) => setForbidden(event.target.value)}
              placeholder="full refund tomorrow"
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveSet()}
            className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save label set"}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={runLive}
              onChange={(event) => setRunLive(event.target.checked)}
            />
            Include live provider when running
          </label>
        </div>
      </div>

      {sets.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {sets.map((set) => (
            <li
              key={set.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-canvas px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">{set.name}</p>
                <p className="text-[11px] text-ink-3">
                  {set.item_count || set.items?.length || 0} example
                  {(set.item_count || set.items?.length || 0) === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={runningId === set.id}
                  onClick={() => void runSet(set.id)}
                  className="rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-ink-2 disabled:opacity-50"
                >
                  {runningId === set.id ? "Running..." : "Run checks"}
                </button>
                <button
                  type="button"
                  onClick={() => void archiveSet(set.id)}
                  className="rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] text-ink-3"
                >
                  Archive
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-ink-3">
          No label sets yet. Save one example above to start.
        </p>
      )}

      {lastRun ? (
        <div className="mt-4 rounded-xl border border-line bg-canvas p-3">
          <p className="text-xs font-medium text-ink">
            Last run: {lastRun.passed}/{lastRun.total} passed ({lastRun.score}
            %) · {lastRun.mode}
            {lastRun.llm_calls ? " · " + lastRun.llm_calls + " LLM calls" : ""}
          </p>
          <ul className="mt-2 space-y-1">
            {lastRun.results.map((row, index) => (
              <li key={index} className="text-[11px] text-ink-2">
                <span
                  className={
                    row.passed ? "font-medium text-ok" : "font-medium text-danger"
                  }
                >
                  {row.passed ? "Pass" : "Fail"}
                </span>
                {" \u00b7 "}
                expected {row.expected_decision}, got{" "}
                {row.actual_decision || "\u2014"}
                {" \u00b7 "}
                {row.detail}
                {row.live_reply ? (
                  <span className="block text-ink-3">
                    Live: {row.live_reply.slice(0, 120)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice ? <p className="mt-3 text-xs text-ink-2">{notice}</p> : null}
    </section>
  );
}
