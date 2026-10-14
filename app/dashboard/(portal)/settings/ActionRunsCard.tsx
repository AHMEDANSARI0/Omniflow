"use client";

import { useCallback, useEffect, useState } from "react";

// §225: the Action Engine execution ledger - every action the AI, a
// workflow, an approval or a teammate ran, with its outcome.

type RunStatus = "executed" | "approval_required" | "denied" | "error";

interface ActionRunRow {
  id: number;
  label: string;
  status: string;
  risk: string;
  actor: string;
  actorKind: "workflow" | "approval" | "ai" | "person";
  error: string | null;
  attempts: number;
  durationMs: number | null;
  approvalId: number | null;
  idempotent: boolean;
  createdAt: string | null;
}

interface ActionRunsPayload {
  runs: ActionRunRow[];
  counts: Record<string, number>;
  keepDays: number;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  executed: "Done",
  approval_required: "Needs approval",
  denied: "Blocked",
  error: "Failed",
};

const STATUS_STYLES: Record<RunStatus, string> = {
  executed: "bg-ok-soft text-ok",
  approval_required: "bg-brand-soft text-brand",
  denied: "bg-warn-soft text-ink-2",
  error: "bg-danger-soft text-danger",
};

function actorLabel(row: ActionRunRow): string {
  if (row.actorKind === "workflow") return "Workflow #" + row.actor.split(":")[1];
  if (row.actorKind === "approval") return "Approved action";
  if (row.actorKind === "ai") return "AI";
  return row.actor || "Teammate";
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ActionRunsCard() {
  const [data, setData] = useState<ActionRunsPayload | null>(null);
  const [filter, setFilter] = useState<RunStatus | "">("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/actions/runs" + (filter ? "?status=" + filter : ""),
        { cache: "no-store" }
      );
      if (response.ok) {
        setData((await response.json()) as ActionRunsPayload);
      } else {
        setNote("Could not load the action log. Try again shortly.");
      }
    } catch {
      setNote("Could not load the action log. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.runs ?? [];

  return (
    <section className="mt-6 rounded-2xl border border-line bg-white p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Action log</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Every action the AI, workflows and approvals ran, with the
            outcome. Kept for {data?.keepDays ?? 30} days.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-line inline-flex min-h-8 items-center px-2.5 py-1 text-[11px] text-ink-2 hover:bg-line/60 disabled:opacity-50"
        >
          {busy ? "Loading..." : "Refresh"}
        </button>
      </div>

      {data ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(Object.keys(STATUS_LABELS) as RunStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => setFilter(filter === status ? "" : status)}
              aria-pressed={filter === status}
              className={
                "rounded-lg border border-line px-2 py-0.5 text-[11px] " +
                (filter === status
                  ? STATUS_STYLES[status]
                  : "text-ink-3 hover:bg-line/60")
              }
            >
              {STATUS_LABELS[status]} · {data.counts[status] ?? 0}
            </button>
          ))}
          <span className="self-center text-[10px] text-ink-3">last 7 days</span>
        </div>
      ) : null}

      {note ? <p className="mt-2 text-xs text-ink-3">{note}</p> : null}

      <div className="mt-3 space-y-1.5">
        {rows.length === 0 ? (
          <p className="rounded-xl border border-line px-3 py-4 text-center text-xs text-ink-3">
            {data ? "No actions recorded yet." : busy ? "Loading..." : ""}
          </p>
        ) : (
          rows.map((row) => {
            const status = row.status as RunStatus;
            return (
              <div key={row.id} className="rounded-xl border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm text-ink">{row.label}</p>
                  <span
                    className={
                      "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] " +
                      (STATUS_STYLES[status] ?? "bg-soft text-ink-2")
                    }
                  >
                    {STATUS_LABELS[status] ?? row.status}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-ink-3">
                  {actorLabel(row)}
                  {row.risk ? " · " + row.risk + " risk" : ""}
                  {" · " + formatWhen(row.createdAt)}
                  {row.durationMs !== null ? " · " + String(row.durationMs) + " ms" : ""}
                  {row.attempts > 1 ? " · " + String(row.attempts) + " tries" : ""}
                  {row.idempotent ? " · Once-only" : ""}
                </p>
                {row.error ? (
                  <p className="mt-0.5 truncate text-[11px] text-danger">{row.error}</p>
                ) : null}
                {row.approvalId && status === "approval_required" ? (
                  <a
                    href="/dashboard/approvals"
                    className="mt-0.5 inline-block text-[11px] text-brand hover:underline"
                  >
                    Open approvals
                  </a>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
