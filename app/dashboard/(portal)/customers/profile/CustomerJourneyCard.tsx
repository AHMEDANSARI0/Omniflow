"use client";

import { useCallback, useEffect, useState } from "react";

interface JourneyStage {
  id: number;
  name: string;
  position: number;
  is_active: boolean;
}

interface JourneyEvent {
  stage_name: string;
  source: string;
  created_at: string | null;
}

interface ExplainActivity {
  action: string;
  actor_kind: string;
  note: string;
  created_at: string | null;
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

/**
 * Customer 360 -> journey + explain: the contact's stage (click to move),
 * the recent stage transitions, and the "why did this happen" activity
 * timeline pulled straight from the audit log.
 */
export default function CustomerJourneyCard({ contact }: { contact: string }) {
  const [stages, setStages] = useState<JourneyStage[]>([]);
  const [currentStageId, setCurrentStageId] = useState(0);
  const [events, setEvents] = useState<JourneyEvent[]>([]);
  const [activity, setActivity] = useState<ExplainActivity[]>([]);
  const [newStage, setNewStage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!contact) return;
    try {
      const [journeyRes, explainRes] = await Promise.all([
        fetch(
          "/api/omniflow/portal/journey?contact=" +
            encodeURIComponent(contact),
          { cache: "no-store" }
        ),
        fetch(
          "/api/omniflow/portal/explain?contact=" +
            encodeURIComponent(contact),
          { cache: "no-store" }
        ),
      ]);
      if (journeyRes.ok) {
        const payload = (await journeyRes.json()) as {
          stages?: JourneyStage[];
          current?: { stage_id: number } | null;
          events?: JourneyEvent[];
        };
        setStages(payload.stages ?? []);
        setCurrentStageId(payload.current?.stage_id ?? 0);
        setEvents(payload.events ?? []);
      }
      if (explainRes.ok) {
        const payload = (await explainRes.json()) as {
          activity?: ExplainActivity[];
        };
        setActivity(payload.activity ?? []);
      }
    } catch {
      /* keep the last known state */
    }
  }, [contact]);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(stageId: number) {
    if (stageId === currentStageId) return;
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/journey", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact, stage_id: stageId }),
      });
      if (response.ok) await load();
    } catch {
      /* keep the last known state */
    } finally {
      setBusy(false);
    }
  }

  async function addStage() {
    const name = newStage.trim();
    if (!name) return;
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/journey/stages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (response.ok) {
        setNewStage("");
        await load();
      }
    } catch {
      /* keep the last known state */
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <p className="text-xs font-semibold text-white">Journey</p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Where this customer stands. A fully paid order moves them to
        &quot;Customer&quot; automatically; every move is logged as an event.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {stages
          .filter((stage) => stage.is_active)
          .map((stage) => (
            <button
              key={stage.id}
              onClick={() => void move(stage.id)}
              disabled={busy}
              className={
                "rounded-full border px-3 py-1 text-[11px] transition-colors " +
                (stage.id === currentStageId
                  ? "border-emerald-400/40 bg-emerald-400/[0.12] text-emerald-200"
                  : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:bg-white/[0.05]")
              }
            >
              {stage.name}
            </button>
          ))}
        <span className="flex items-center gap-1">
          <input
            value={newStage}
            onChange={(event) => setNewStage(event.target.value)}
            placeholder="new stage"
            className="w-24 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-slate-200 outline-none placeholder:text-slate-600"
          />
          <button
            onClick={() => void addStage()}
            disabled={busy || !newStage.trim()}
            className="text-[11px] text-cyan-300 hover:underline disabled:opacity-40"
          >
            Add
          </button>
        </span>
      </div>

      {events.length > 0 ? (
        <p className="mt-2 text-[10px] text-slate-600">
          Last move: {events[0].stage_name}
          {events[0].source !== "owner" ? " (auto)" : ""} &middot;{" "}
          {formatWhen(events[0].created_at)}
        </p>
      ) : null}

      {activity.length > 0 ? (
        <div className="mt-3 border-t border-white/[0.05] pt-2">
          <p className="text-[11px] font-semibold text-slate-300">
            Why this happened
          </p>
          <ul className="mt-1 space-y-0.5">
            {activity.slice(0, 5).map((row, index) => (
              <li
                key={index}
                className="flex items-baseline justify-between gap-2 text-[10px]"
              >
                <span className="min-w-0 truncate text-slate-500">
                  <span className="text-slate-400">{row.action}</span>
                  {row.note ? " \u2014 " + row.note : ""}
                </span>
                <span className="shrink-0 text-slate-600">
                  {formatWhen(row.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
