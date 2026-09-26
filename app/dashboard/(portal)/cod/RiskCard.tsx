"use client";

import { useCallback, useEffect, useState } from "react";

interface RiskFactor {
  key: string;
  points: number;
  note: string;
}

interface RiskScore {
  score: number;
  factors: RiskFactor[];
  recommendation: "proceed" | "collect_advance" | "hold";
  threshold: number;
  task_created: boolean;
}

interface RiskTask {
  id: number;
  contact_id: string;
  score: number;
  created_at: string | null;
}

const RECO: Record<string, { label: string; cls: string }> = {
  proceed: {
    label: "Proceed",
    cls: "border-emerald-400/30 bg-emerald-400/[0.08] text-ok",
  },
  collect_advance: {
    label: "Collect advance",
    cls: "border-amber-400/30 bg-amber-400/[0.08] text-amber-200",
  },
  hold: {
    label: "Hold",
    cls: "border-rose-400/30 bg-rose-400/[0.08] text-rose-200",
  },
};

/**
 * COD intelligence: the RTO score for one contact (0-100, pure math
 * over the shop's own history) with the WHY breakdown, the threshold +
 * staff-task switch, and the open staff tasks. Advisory by default.
 */
export default function RiskCard() {
  const [contact, setContact] = useState("");
  const [total, setTotal] = useState("");
  const [result, setResult] = useState<RiskScore | null>(null);
  const [threshold, setThreshold] = useState("70");
  const [staffTasks, setStaffTasks] = useState(false);
  const [tasks, setTasks] = useState<RiskTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const [settingsRes, tasksRes] = await Promise.all([
        fetch("/api/omniflow/portal/risk/settings", { cache: "no-store" }),
        fetch("/api/omniflow/portal/risk/tasks", { cache: "no-store" }),
      ]);
      if (settingsRes.ok) {
        const payload = (await settingsRes.json()) as {
          settings?: { score_threshold: number; staff_tasks: boolean };
        };
        if (payload.settings) {
          setThreshold(String(payload.settings.score_threshold));
          setStaffTasks(payload.settings.staff_tasks);
        }
      }
      if (tasksRes.ok) {
        const payload = (await tasksRes.json()) as { tasks?: RiskTask[] };
        setTasks(payload.tasks ?? []);
      }
    } catch {
      /* keep defaults */
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function check() {
    const clean = contact.trim();
    if (!clean) return;
    setBusy(true);
    setResult(null);
    setNote(null);
    try {
      const query = new URLSearchParams({ contact: clean });
      if (total) query.set("total", total);
      const response = await fetch("/api/omniflow/portal/risk/score?" + query.toString());
      if (response.ok) {
        setResult((await response.json()) as RiskScore);
      } else {
        setNote("Risk check failed. Try again shortly.");
      }
    } catch {
      setNote("Risk check failed. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(nextThreshold: string, nextStaff: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/risk/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          score_threshold: Number(nextThreshold) || 70,
          staff_tasks: nextStaff,
          city_default_pct: 30,
        }),
      });
      if (response.ok) {
        setStaffTasks(nextStaff);
        setNote("Saved.");
      } else {
        setNote("Could not save.");
      }
    } catch {
      setNote("Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function completeTask(id: number) {
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/risk/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (response.ok) await loadSettings();
    } catch {
      /* keep list */
    } finally {
      setBusy(false);
    }
  }

  const reco = result ? RECO[result.recommendation] : null;

  return (
    <section className="mt-4 rounded-2xl border border-line bg-soft p-4">
      <p className="text-xs font-semibold text-ink">COD risk check</p>
      <p className="mt-0.5 text-[11px] text-ink-3">
        RTO score 0-100 from this customer&apos;s own history - returns,
        confirm speed, order value, city. Advisory by default; nothing
        is blocked automatically.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          placeholder="customer number e.g. 92300..."
          className="min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
        />
        <input
          value={total}
          onChange={(event) => setTotal(event.target.value)}
          placeholder="order value"
          inputMode="decimal"
          className="w-28 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
        />
        <button
          onClick={() => void check()}
          disabled={busy || !contact.trim()}
          className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-40"
        >
          Check risk
        </button>
      </div>

      {result ? (
        <div className="mt-3 rounded-xl border border-line bg-soft p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xl font-semibold text-ink">
              {result.score}
              <span className="ml-1 text-[11px] font-normal text-ink-3">
                / 100 risk
              </span>
            </p>
            {reco ? (
              <span
                className={
                  "rounded-full border px-2.5 py-1 text-[11px] " + reco.cls
                }
              >
                {reco.label}
              </span>
            ) : null}
          </div>
          <ul className="mt-2 space-y-1">
            {result.factors.map((factor) => (
              <li
                key={factor.key}
                className="flex items-baseline justify-between gap-2 text-[11px]"
              >
                <span className="min-w-0 text-ink-3">
                  {factor.note}
                </span>
                <span
                  className={
                    "shrink-0 font-medium " +
                    (factor.points > 0
                      ? "text-danger"
                      : factor.points < 0
                        ? "text-ok"
                        : "text-ink-3")
                  }
                >
                  {factor.points > 0 ? "+" : ""}
                  {factor.points}
                </span>
              </li>
            ))}
          </ul>
          {result.task_created ? (
            <p className="mt-2 text-[11px] text-amber-600">
              Staff task created - it is in the list below.
            </p>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="mt-2 text-[11px] text-ink-3">{note}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2">
        <span className="text-[11px] text-ink-3">Hold threshold</span>
        <input
          value={threshold}
          onChange={(event) => setThreshold(event.target.value)}
          inputMode="numeric"
          className="w-16 rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink outline-none"
        />
        <button
          onClick={() => void saveSettings(threshold, staffTasks)}
          disabled={busy}
          className="text-[11px] text-brand hover:underline disabled:opacity-40"
        >
          Save
        </button>
        <button
          onClick={() => void saveSettings(threshold, !staffTasks)}
          disabled={busy}
          className={
            "ml-auto rounded-full border px-3 py-1 text-[11px] " +
            (staffTasks
              ? "border-emerald-400/40 bg-emerald-400/[0.12] text-ok"
              : "border-line bg-soft text-ink-3")
          }
        >
          Staff tasks: {staffTasks ? "on" : "off"}
        </button>
      </div>

      {tasks.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {tasks.slice(0, 5).map((task) => (
            <li
              key={task.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-1.5"
            >
              <span className="min-w-0 truncate text-[11px] text-amber-200">
                Review {task.contact_id} (risk {task.score})
              </span>
              <button
                onClick={() => void completeTask(task.id)}
                disabled={busy}
                className="shrink-0 text-[11px] text-ink-3 hover:underline disabled:opacity-40"
              >
                Done
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
