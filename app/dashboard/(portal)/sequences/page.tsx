"use client";

import { useCallback, useEffect, useState } from "react";

interface Step {
  step_no: number;
  delay_hours: number;
  body: string;
}

interface Sequence {
  id: number;
  name: string;
  enabled: boolean;
  steps: Step[];
  activeEnrollments: number;
}

interface DraftStep {
  delay_hours: number;
  body: string;
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[] | null>(null);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<DraftStep[]>([
    { delay_hours: 0, body: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [enrollments, setEnrollments] = useState<
    { id: number; contact_name: string | null; current_step: number; status: string }[]
  >([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/sequences", {
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const list = (payload as { sequences?: Sequence[] }).sequences;
        setSequences(Array.isArray(list) ? list : []);
      }
    } catch {
      setSequences([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addStep = () => {
    setDraft((current) =>
      current.length < 5
        ? [...current, { delay_hours: 24, body: "" }]
        : current
    );
  };

  const patchStep = (index: number, changes: Partial<DraftStep>) => {
    setDraft((current) =>
      current.map((step, i) => (i === index ? { ...step, ...changes } : step))
    );
  };

  const create = useCallback(async () => {
    if (!name.trim() || draft.some((step) => !step.body.trim())) {
      setNoteTone("amber");
      setNote("Give the series a name and fill every step's message.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, steps: draft }),
      });
      if (response.ok) {
        setNoteTone("emerald");
        setNote("Series created. Toggle it on to enroll new contacts.");
        setName("");
        setDraft([{ delay_hours: 0, body: "" }]);
        void load();
        return;
      }
      setNoteTone("amber");
      setNote("Could not create. Check steps (1-5, 0-168h each).");
    } catch {
      setNoteTone("amber");
      setNote("Could not create. Try again.");
    } finally {
      setBusy(false);
    }
  }, [name, draft, load]);

  const setEnabled = useCallback(
    async (row: Sequence, enabled: boolean) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/sequences/" + String(row.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        void load();
      } catch {
        void load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const remove = useCallback(
    async (row: Sequence) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/sequences/" + String(row.id), {
          method: "DELETE",
        });
        void load();
      } catch {
        void load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const showLog = useCallback(
    async (id: number) => {
      if (openLog === id) {
        setOpenLog(null);
        return;
      }
      setOpenLog(id);
      setEnrollments([]);
      try {
        const response = await fetch(
          "/api/omniflow/portal/sequences/" + String(id) + "/enrollments",
          { cache: "no-store" }
        );
        const payload: unknown = await response.json().catch(() => null);
        if (payload !== null && typeof payload === "object") {
          const list = (payload as { enrollments?: typeof enrollments }).enrollments;
          setEnrollments(Array.isArray(list) ? list : []);
        }
      } catch {
        setEnrollments([]);
      }
    },
    [openLog]
  );

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Sequences</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            A multi-message series that new contacts receive automatically,
            step by step. Great for welcome flows and first-order care.
          </p>
        </div>

        <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-white">New series</h2>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Series name, e.g. Welcome flow"
            className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <div className="mt-3 space-y-2">
            {draft.map((step, index) => (
              <div
                key={index}
                className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">
                    Step {index + 1}
                    {index === 0
                      ? " \u00b7 sends after this many hours"
                      : " \u00b7 waits this many hours"}
                  </p>
                  {draft.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current) => current.filter((_, i) => i !== index))
                      }
                      className="text-[11px] text-slate-500 transition hover:text-rose-300"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={168}
                    value={step.delay_hours}
                    onChange={(event) =>
                      patchStep(index, {
                        delay_hours: Math.max(
                          0,
                          Math.min(168, Number(event.target.value) || 0)
                        ),
                      })
                    }
                    className="w-20 shrink-0 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-400/40"
                  />
                  <span className="shrink-0 text-xs text-slate-500">hours</span>
                </div>
                <textarea
                  value={step.body}
                  onChange={(event) => patchStep(index, { body: event.target.value })}
                  rows={2}
                  maxLength={1000}
                  placeholder={"Use {name} and it becomes each customer's first name."}
                  className="mt-2 w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {draft.length < 5 ? (
              <button
                type="button"
                onClick={addStep}
                className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
              >
                + Add step
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {busy ? "Working\u2026" : "Create series"}
            </button>
            {note ? (
              <p
                className={
                  "text-xs " +
                  (noteTone === "emerald" ? "text-emerald-300" : "text-amber-300")
                }
              >
                {note}
              </p>
            ) : null}
          </div>
        </div>

        {sequences === null ? (
          <p className="text-sm text-slate-500">Loading\u2026</p>
        ) : sequences.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-8 text-center">
            <p className="text-sm text-slate-400">No series yet.</p>
            <p className="mt-1 text-xs text-slate-600">
              Create one above; every brand-new contact will walk through it.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {sequences.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">{row.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {row.steps.length} step{row.steps.length === 1 ? "" : "s"} \u00b7{" "}
                      {row.activeEnrollments} active
                      {row.enabled ? " \u00b7 enrolling" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void setEnabled(row, !row.enabled)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {row.enabled ? "Turn off" : "Turn on"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void showLog(row.id)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {openLog === row.id ? "Hide people" : "People"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(row)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-400/40 hover:text-rose-300"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {openLog === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    {enrollments.length === 0 ? (
                      <p className="text-xs text-slate-500">No enrollments yet.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {enrollments.map((enrollment) => (
                          <li
                            key={enrollment.id}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate text-slate-300">
                              {enrollment.contact_name || "Customer"}
                            </span>
                            <span
                              className={
                                enrollment.status === "completed"
                                  ? "text-emerald-300"
                                  : "text-amber-300"
                              }
                            >
                              {enrollment.status === "completed"
                                ? "completed"
                                : "step " + String(enrollment.current_step + 1) + " pending"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
