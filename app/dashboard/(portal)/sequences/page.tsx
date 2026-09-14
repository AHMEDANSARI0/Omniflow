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
  completedEnrollments: number;
  triggerKeyword: string | null;
}

interface DraftStep {
  delay_hours: number;
  body: string;
}

const TEMPLATES: {
  label: string;
  name: string;
  keyword: string;
  steps: DraftStep[];
}[] = [
  {
    label: "Welcome flow",
    name: "Welcome flow",
    keyword: "",
    steps: [
      {
        delay_hours: 0,
        body: "Welcome {name}! Thanks for reaching out \u2014 reply here anytime and we'll help you out.",
      },
    ],
  },
  {
    label: "Order follow-up",
    name: "Order follow-up",
    keyword: "",
    steps: [
      {
        delay_hours: 0,
        body: "Thank you {name}! Your order is confirmed. We'll share delivery updates right here.",
      },
      {
        delay_hours: 24,
        body: "Hi {name}, did your order arrive safely? Reply if you need anything.",
      },
    ],
  },
  {
    label: "Reorder nudge",
    name: "Reorder nudge",
    keyword: "reorder",
    steps: [
      {
        delay_hours: 72,
        body: "Hi {name}! Time for a refill? Send REORDER and we'll set you up.",
      },
      {
        delay_hours: 96,
        body: "{name}, your favourites are back in stock. Reply REORDER and we'll reserve them for you.",
      },
    ],
  },
  {
    label: "Review request",
    name: "Review request",
    keyword: "",
    steps: [
      {
        delay_hours: 48,
        body: "Hi {name}! Glad you shopped with us. Could you spare a minute to share your experience?",
      },
    ],
  },
];

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
  const [keyword, setKeyword] = useState("");
  const [triggerOpenFor, setTriggerOpenFor] = useState<number | null>(null);
  const [triggerDraft, setTriggerDraft] = useState("");
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [addOpenFor, setAddOpenFor] = useState<number | null>(null);
  const [addDraft, setAddDraft] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addNote, setAddNote] = useState<string | null>(null);
  const [editOpenFor, setEditOpenFor] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<DraftStep[]>([]);
  const [editBusy, setEditBusy] = useState(false);
  const [editNote, setEditNote] = useState<string | null>(null);

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

  const applyTemplate = (template: (typeof TEMPLATES)[number]) => {
    setName(template.name);
    setKeyword(template.keyword);
    setDraft(template.steps.map((step) => ({ ...step })));
    setNoteTone("neutral");
    setNote("Template loaded \u2014 edit anything, then Create series.");
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
        body: JSON.stringify(
          keyword.trim()
            ? { name, steps: draft, trigger_keyword: keyword.trim() }
            : { name, steps: draft }
        ),
      });
      if (response.ok) {
        setNoteTone("emerald");
        setNote(
          keyword.trim()
            ? "Series created. Send the keyword in a chat to start it."
            : "Series created. Toggle it on to enroll new contacts."
        );
        setName("");
        setKeyword("");
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
  }, [name, draft, keyword, load]);

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

  const openAdd = useCallback((id: number) => {
    setAddOpenFor(id);
    setAddDraft("");
    setAddNote(null);
  }, []);

  const openTrigger = useCallback((row: Sequence) => {
    setTriggerOpenFor(row.id);
    setTriggerDraft(row.triggerKeyword ?? "");
  }, []);

  const openEdit = useCallback((row: Sequence) => {
    setEditOpenFor(row.id);
    setEditDraft(
      row.steps.map((step) => ({ delay_hours: step.delay_hours, body: step.body }))
    );
    setEditNote(null);
  }, []);

  const patchEditStep = (index: number, changes: Partial<DraftStep>) => {
    setEditDraft((current) =>
      current.map((step, i) => (i === index ? { ...step, ...changes } : step))
    );
  };

  const saveEdit = useCallback(
    async (row: Sequence, asCopy: boolean) => {
      if (editBusy) return;
      const steps = editDraft.map((step) => ({
        delay_hours: step.delay_hours,
        body: step.body,
      }));
      if (steps.length === 0 || steps.some((step) => !step.body.trim())) {
        setEditNote("Fill every step's message.");
        return;
      }
      setEditBusy(true);
      setEditNote(null);
      try {
        if (asCopy) {
          const response = await fetch("/api/omniflow/portal/sequences", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: row.name + " copy", steps }),
          });
          if (!response.ok) {
            setEditNote("Could not save the copy. Check steps (1-5, 0-168h each).");
            return;
          }
        } else {
          const response = await fetch(
            "/api/omniflow/portal/sequences/" + String(row.id) + "/steps",
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ steps }),
            }
          );
          if (!response.ok) {
            setEditNote(
              response.status === 404
                ? "Series not found."
                : "Could not save. Check steps (1-5, 0-168h each)."
            );
            return;
          }
        }
        setEditOpenFor(null);
        void load();
      } catch {
        setEditNote("Could not save. Try again.");
      } finally {
        setEditBusy(false);
      }
    },
    [editBusy, editDraft, load]
  );

  const saveTrigger = useCallback(
    async (row: Sequence) => {
      if (triggerBusy) return;
      setTriggerBusy(true);
      try {
        await fetch("/api/omniflow/portal/sequences/" + String(row.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            triggerKeyword: triggerDraft.trim() ? triggerDraft.trim() : null,
          }),
        });
        setTriggerOpenFor(null);
        void load();
      } catch {
        setTriggerOpenFor(null);
      } finally {
        setTriggerBusy(false);
      }
    },
    [triggerBusy, triggerDraft, load]
  );

  const submitAdd = useCallback(
    async (id: number) => {
      const contacts = addDraft
        .split(/[,;\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (addBusy || contacts.length === 0) return;
      setAddBusy(true);
      setAddNote(null);
      try {
        const response = await fetch(
          "/api/omniflow/portal/sequences/" + String(id) + "/enrollments",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contacts }),
          }
        );
        const payload = (await response.json().catch(() => null)) as {
          enrolled?: number;
          skipped?: string[];
        } | null;
        if (response.ok && payload && typeof payload.enrolled === "number") {
          const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
          setAddNote(
            "Enrolled " + String(payload.enrolled) +
              (skipped > 0 ? " \u00b7 " + String(skipped) + " skipped (no chat yet)" : "")
          );
          setAddDraft("");
          void load();
        } else {
          setAddNote("Could not add people. Try again.");
        }
      } catch {
        setAddNote("Could not add people. Try again.");
      } finally {
        setAddBusy(false);
      }
    },
    [addBusy, addDraft, load]
  );

  const cancelEnrollment = useCallback(
    async (sequenceId: number, enrollmentId: number) => {
      try {
        await fetch(
          "/api/omniflow/portal/sequences/" + String(sequenceId) +
            "/enrollments/" + String(enrollmentId),
          { method: "DELETE" }
        );
      } catch {
        // Transient network issue — reopening the log refreshes it.
      }
      void showLog(sequenceId);
    },
    [showLog]
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-slate-500">
              Start from:
            </span>
            {TEMPLATES.map((template) => (
              <button
                key={template.label}
                type="button"
                onClick={() => applyTemplate(template)}
                className="rounded-full border border-white/[0.08] px-3 py-1 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-200"
              >
                {template.label}
              </button>
            ))}
          </div>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Series name, e.g. Welcome flow"
            className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="Trigger keyword (optional), e.g. CATALOG"
            className="mt-2 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
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
                    <span className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-200">{row.name}</p>
                      {row.triggerKeyword ? (
                        <span className="shrink-0 rounded-md border border-cyan-400/25 bg-cyan-400/[0.08] px-1.5 py-0.5 text-[10px] text-cyan-300">
                          {row.triggerKeyword}
                        </span>
                      ) : null}
                    </span>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {row.steps.length} step{row.steps.length === 1 ? "" : "s"} \u00b7{" "}
                      {row.activeEnrollments} active
                      {" \u00b7 "}
                      {row.completedEnrollments} done
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
                      onClick={() => openAdd(row.id)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      Add people
                    </button>
                    <button
                      type="button"
                      onClick={() => openTrigger(row)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      Trigger
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(row)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      Edit
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
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] uppercase tracking-wider text-slate-500">
                        People in {row.name}
                      </p>
                      <a
                        href={
                          "/api/omniflow/portal/sequences/" +
                          String(row.id) +
                          "/enrollments/export"
                        }
                        className="text-[11px] text-cyan-300 transition hover:text-cyan-200"
                      >
                        Export CSV
                      </a>
                    </div>
                    <div className="mt-2">
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
                            {enrollment.status === "active" ? (
                              <button
                                type="button"
                                onClick={() => void cancelEnrollment(row.id, enrollment.id)}
                                className="text-[11px] text-slate-500 transition hover:text-rose-300"
                              >
                                Cancel
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    </div>
                  </div>
                ) : null}
                {triggerOpenFor === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">
                      Keyword trigger for {row.name}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        value={triggerDraft}
                        onChange={(event) => setTriggerDraft(event.target.value)}
                        placeholder="e.g. CATALOG"
                        className="w-44 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
                      />
                      <button
                        type="button"
                        onClick={() => void saveTrigger(row)}
                        disabled={triggerBusy}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50"
                      >
                        {triggerBusy ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setTriggerOpenFor(null)}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                      >
                        Close
                      </button>
                    </div>
                    <p className="mt-2 text-[10px] text-slate-600">
                      When a customer sends exactly this word, the series starts for
                      them. Leave empty to turn the trigger off.
                    </p>
                  </div>
                ) : null}
                {editOpenFor === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">
                      Edit steps \u2014 {row.name}
                    </p>
                    <div className="mt-2 space-y-2">
                      {editDraft.map((step, index) => (
                        <div
                          key={index}
                          className="rounded-lg border border-white/[0.06] bg-white/[0.015] p-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[10px] uppercase tracking-wider text-slate-500">
                              Step {index + 1}
                            </p>
                            {editDraft.length > 1 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setEditDraft((current) =>
                                    current.filter((_, i) => i !== index)
                                  )
                                }
                                className="text-[11px] text-slate-500 transition hover:text-rose-300"
                              >
                                Remove
                              </button>
                            ) : null}
                          </div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <input
                              type="number"
                              min={0}
                              max={168}
                              value={step.delay_hours}
                              onChange={(event) =>
                                patchEditStep(index, {
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
                            onChange={(event) =>
                              patchEditStep(index, { body: event.target.value })
                            }
                            rows={2}
                            maxLength={1000}
                            placeholder="Use {name} for the customer's first name."
                            className="mt-2 w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {editDraft.length < 5 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setEditDraft((current) => [
                              ...current,
                              { delay_hours: 24, body: "" },
                            ])
                          }
                          className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                        >
                          + Add step
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void saveEdit(row, false)}
                        disabled={editBusy}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50"
                      >
                        {editBusy ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveEdit(row, true)}
                        disabled={editBusy}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:opacity-50"
                      >
                        Save as copy
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditOpenFor(null)}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                      >
                        Close
                      </button>
                      {editNote ? (
                        <p className="text-xs text-amber-300">{editNote}</p>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-600">
                      People already in the series continue with the new steps. Save as
                      copy keeps this series untouched.
                    </p>
                  </div>
                ) : null}
                {addOpenFor === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">
                      Add people to {row.name}
                    </p>
                    <textarea
                      value={addDraft}
                      onChange={(event) => setAddDraft(event.target.value)}
                      rows={3}
                      placeholder={"One number per line\n+92 300 1234567"}
                      className="mt-2 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void submitAdd(row.id)}
                        disabled={addBusy || !addDraft.trim()}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50"
                      >
                        {addBusy ? "Adding..." : "Add to sequence"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddOpenFor(null)}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                      >
                        Close
                      </button>
                      {addNote ? (
                        <span className="text-[11px] text-slate-400">{addNote}</span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-600">
                      Only customers who already have a chat are added. Everyone keeps
                      their own step position.
                    </p>
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
