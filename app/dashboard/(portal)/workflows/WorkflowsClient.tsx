"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  PortalWorkflow,
  PortalWorkflowVersion,
  WorkflowCatalog,
  WorkflowRun,
  WorkflowStepKind,
  WorkflowTemplate,
} from "../../../../lib/omniflow/portal";
import { StepInspector, TriggerInspector } from "./StepInspector";
import WorkflowGenerator, { type GeneratorTarget } from "./WorkflowGenerator";
import WorkflowCanvas, { type Selection } from "./WorkflowCanvas";
import {
  MAX_STEPS_DEFAULT,
  allIssues,
  blankEditor,
  changeKind,
  duplicateStep,
  editorFromTemplate,
  editorFromWorkflow,
  editorPayload,
  insertStep,
  moveStep,
  moveToSlot,
  removeStep,
  type EditorState,
  type EditorStep,
} from "./workflow-model";

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
const smallInput =
  "w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40";
const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";
const ghostBtn =
  "rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:border-line-2 hover:text-ink disabled:opacity-50";
const dangerBtn =
  "rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-medium text-rose-700 transition-colors duration-300 hover:bg-rose-50 disabled:opacity-50";

const ZOOM_LEVELS = [0.75, 1, 1.25];

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "border-emerald-400/30 bg-emerald-400/10 text-ok",
    paused: "border-amber-300/40 bg-amber-50 text-amber-700",
    draft: "border-line-2 bg-soft text-ink-3",
    running: "border-brand/25 bg-brand-soft text-brand",
    waiting: "border-brand/25 bg-brand-soft text-brand",
    waiting_approval: "border-amber-300/40 bg-amber-50 text-amber-700",
    completed: "border-line-2 bg-soft text-ink-2",
    goal_reached: "border-emerald-400/30 bg-emerald-400/10 text-ok",
    stopped: "border-line-2 bg-soft text-ink-3",
    failed: "border-rose-200 bg-rose-50 text-rose-700",
  };
  return (
    <span
      className={
        "rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize " +
        (styles[status] || "border-line-2 bg-soft text-ink-3")
      }
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WorkflowsClient({
  initialWorkflows,
}: {
  initialWorkflows: PortalWorkflow[] | null;
}) {
  const [workflows, setWorkflows] = useState<PortalWorkflow[] | null>(initialWorkflows);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [selected, setSelected] = useState<Selection>("trigger");
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [runsFor, setRunsFor] = useState<number | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [versionsFor, setVersionsFor] = useState<number | null>(null);
  const [versions, setVersions] = useState<PortalWorkflowVersion[] | null>(null);
  const [testFor, setTestFor] = useState<number | null>(null);
  const [testConversation, setTestConversation] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState("");
  /** §231 generator panel: null = closed; current = "change with AI". */
  const [generator, setGenerator] = useState<{ current: GeneratorTarget | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const [listRes, catalogRes] = await Promise.all([
        fetch("/api/omniflow/portal/workflows", { cache: "no-store" }),
        fetch("/api/omniflow/portal/workflows/catalog", { cache: "no-store" }),
      ]);
      if (listRes.ok) {
        const payload = (await listRes.json()) as { workflows?: PortalWorkflow[] };
        setWorkflows(payload.workflows ?? []);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
      if (catalogRes.ok) {
        const payload = (await catalogRes.json()) as { catalog?: WorkflowCatalog };
        setCatalog(payload.catalog ?? null);
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function flash(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 2800);
  }

  const triggerLabel = useCallback(
    (type: string) =>
      catalog?.triggers.find((t) => t.trigger === type)?.label ?? type.replace(/_/g, " "),
    [catalog]
  );

  const maxSteps = catalog?.limits.maxSteps ?? MAX_STEPS_DEFAULT;
  const maxWorkflows = catalog?.limits.maxWorkflows ?? 20;
  const issues = useMemo(
    () => (editor ? allIssues(editor.steps, catalog) : new Map<number, string[]>()),
    [editor, catalog]
  );

  /** Templates grouped for the picker: recommended vertical first, then general, then the rest. */
  const templateGroups = useMemo(() => {
    if (!catalog) return [];
    const applied = catalog.appliedVertical;
    const order = [...catalog.verticals].sort((a, b) => {
      const rank = (key: string) => (key === applied ? 0 : key === "general" ? 1 : 2);
      return rank(a.key) - rank(b.key);
    });
    return order
      .map((vertical) => ({
        key: vertical.key,
        label:
          vertical.key === applied
            ? "Recommended for " + vertical.label
            : vertical.label,
        templates: catalog.templates.filter((t) => t.vertical === vertical.key),
      }))
      .filter((group) => group.templates.length > 0);
  }, [catalog]);

  // ----- editor open / close -----

  function openEditor(state: EditorState) {
    setSaveError(null);
    setEditor(state);
    setSelected("trigger");
    setTemplateKey("");
  }

  function openNew() {
    openEditor(blankEditor());
  }

  function openTemplate(key: string) {
    const template = catalog?.templates.find((t) => t.key === key);
    if (!template) return;
    openEditor(editorFromTemplate(template));
  }

  function openGenerated(template: WorkflowTemplate) {
    // a change to the open workflow keeps its id: saving makes a new version
    const keepId = generator?.current && editor ? editor.id : null;
    if (!generator?.current && editor &&
        !window.confirm("Replace the workflow open in the builder? Unsaved changes there are lost.")) {
      return;
    }
    openEditor({ ...editorFromTemplate(template), id: keepId });
    setGenerator(null);
    flash("Opened in the builder. Check every step, then save.");
  }

  function changeWithAi() {
    if (!editor) return;
    const status = workflows?.find((w) => w.id === editor.id)?.status;
    setGenerator({
      current: { payload: editorPayload(editor), name: editor.name, active: status === "active" },
    });
  }

  async function openEdit(workflow: PortalWorkflow) {
    setBusyId(workflow.id);
    try {
      const response = await fetch("/api/omniflow/portal/workflows/" + workflow.id, {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as { workflow?: PortalWorkflow };
        if (payload.workflow) openEditor(editorFromWorkflow(payload.workflow));
      } else {
        flash("Could not open that workflow.");
      }
    } catch {
      flash("Could not open that workflow.");
    } finally {
      setBusyId(null);
    }
  }

  // ----- editor mutations (all through the pure model) -----

  function updateEditor(patch: Partial<EditorState>) {
    setEditor((current) => (current ? { ...current, ...patch } : current));
  }

  function setSteps(update: (steps: EditorStep[]) => EditorStep[]) {
    setEditor((current) => (current ? { ...current, steps: update(current.steps) } : current));
  }

  function patchStep(key: number, patch: Partial<EditorStep>) {
    setSteps((steps) => steps.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  }

  function handleInsert(slot: number, kind: WorkflowStepKind) {
    if (!editor || editor.steps.length >= maxSteps) return;
    const result = insertStep(editor.steps, slot, kind);
    setSteps(() => result.steps);
    setSelected(result.key);
  }

  function handleRemove(key: number) {
    setSteps((steps) => removeStep(steps, key));
    setSelected((current) => (current === key ? null : current));
  }

  function handleDuplicate(key: number) {
    if (!editor || editor.steps.length >= maxSteps) return;
    const result = duplicateStep(editor.steps, key);
    setSteps(() => result.steps);
    setSelected(result.key);
  }

  const selectedIndex =
    editor && typeof selected === "number" ? editor.steps.findIndex((s) => s.key === selected) : -1;
  const selectedStep = selectedIndex >= 0 && editor ? editor.steps[selectedIndex] : null;

  async function saveEditor(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;
    if (!editor.name.trim()) {
      setSaveError("Give the workflow a name.");
      return;
    }
    if (editor.steps.length === 0) {
      setSaveError("Add at least one step.");
      return;
    }
    if (issues.size) {
      setSaveError("Fix the highlighted steps first (" + issues.size + " need attention).");
      const firstKey = issues.keys().next().value;
      if (typeof firstKey === "number") setSelected(firstKey);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(
        editor.id ? "/api/omniflow/portal/workflows/" + editor.id : "/api/omniflow/portal/workflows",
        {
          method: editor.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editorPayload(editor)),
        }
      );
      if (response.ok) {
        flash(editor.id ? "Workflow saved as a new version." : "Workflow created as a draft.");
        setEditor(null);
        await load();
      } else {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setSaveError(body?.error?.message ?? "Could not save the workflow.");
      }
    } catch {
      setSaveError("Network problem. Try again.");
    } finally {
      setSaving(false);
    }
  }

  // ----- list actions -----

  async function setStatus(workflow: PortalWorkflow, status: "active" | "paused") {
    setBusyId(workflow.id);
    try {
      const response = await fetch("/api/omniflow/portal/workflows/" + workflow.id + "/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (response.ok) {
        flash(status === "active" ? "Workflow activated." : "Workflow paused.");
        await load();
      } else {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        flash(body?.error?.message ?? "Could not change the status.");
      }
    } catch {
      flash("Network problem. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function archive(workflow: PortalWorkflow) {
    if (!window.confirm("Archive \"" + workflow.name + "\"? Live runs stop; history is kept.")) return;
    setBusyId(workflow.id);
    try {
      const response = await fetch("/api/omniflow/portal/workflows/" + workflow.id, {
        method: "DELETE",
      });
      if (response.ok) {
        flash("Workflow archived.");
        if (editor?.id === workflow.id) setEditor(null);
        await load();
      } else {
        flash("Could not archive the workflow.");
      }
    } catch {
      flash("Network problem. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function openRuns(workflow: PortalWorkflow) {
    setRunsFor(workflow.id);
    setRuns(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/workflows/" + workflow.id + "/runs?limit=20",
        { cache: "no-store" }
      );
      if (response.ok) {
        const payload = (await response.json()) as { runs?: WorkflowRun[] };
        setRuns(payload.runs ?? []);
      } else {
        setRuns([]);
      }
    } catch {
      setRuns([]);
    }
  }

  async function openVersions(workflow: PortalWorkflow) {
    if (versionsFor === workflow.id) {
      setVersionsFor(null);
      setVersions(null);
      return;
    }
    setVersionsFor(workflow.id);
    setVersions(null);
    setBusyId(workflow.id);
    try {
      const response = await fetch(
        "/api/omniflow/portal/workflows/" + workflow.id + "/versions",
        { cache: "no-store" }
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          versions?: PortalWorkflowVersion[];
        };
        setVersions(payload.versions ?? []);
      } else {
        setVersions([]);
      }
    } catch {
      setVersions([]);
    } finally {
      setBusyId(null);
    }
  }

  async function restoreVersion(workflow: PortalWorkflow, version: number) {
    if (
      !window.confirm(
        "Restore version " +
          version +
          "? A new version will be created from that snapshot."
      )
    ) {
      return;
    }
    setBusyId(workflow.id);
    try {
      const response = await fetch(
        "/api/omniflow/portal/workflows/" + workflow.id + "/rollback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version }),
        }
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          version?: number;
          restored_from?: number;
        };
        flash(
          "Restored version " +
            (payload.restored_from ?? version) +
            " as v" +
            (payload.version ?? "")
        );
        await load();
        await openVersions(workflow);
      } else {
        flash("Could not restore that version.");
      }
    } catch {
      flash("Could not restore that version.");
    } finally {
      setBusyId(null);
    }
  }


  async function runTest(workflow: PortalWorkflow) {
    const conversationId = Number.parseInt(testConversation, 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      setTestResult("Enter a conversation id (from the conversation URL).");
      return;
    }
    setBusyId(workflow.id);
    setTestResult(null);
    try {
      const response = await fetch("/api/omniflow/portal/workflows/" + workflow.id + "/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const body = (await response.json().catch(() => null)) as {
        status?: string;
        runId?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && body) {
        setTestResult(
          "Run #" + body.runId + " finished with status: " + String(body.status ?? "").replace(/_/g, " ")
        );
        await load();
      } else {
        setTestResult(body?.error?.message ?? "The test run could not start.");
      }
    } catch {
      setTestResult("Network problem. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  const activeCount = (workflows ?? []).filter((w) => w.status === "active").length;

  // ----- render -----

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Workflows</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-2">
            Trigger-driven automations: a customer event starts a run, then conditions,
            AI decisions, actions, waits and approvals play out step by step. High-risk
            actions always pause for your approval.
          </p>
          {workflows !== null ? (
            <p className="mt-2 text-xs text-ink-3">
              {activeCount} active of {workflows.length} workflows ({maxWorkflows} max)
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={smallInput + " w-auto min-w-[200px]"}
            value={templateKey}
            onChange={(event) => openTemplate(event.target.value)}
            aria-label="Start from template"
          >
            <option value="">Start from template</option>
            {templateGroups.map((group) => (
              <optgroup key={group.key} label={group.label}>
                {group.templates.map((template) => (
                  <option key={template.key} value={template.key}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            className={ghostBtn}
            onClick={() => setGenerator({ current: null })}
          >
            <span aria-hidden className="mr-1 text-brand">{"\u2736"}</span>
            Describe it
          </button>
          <button
            type="button"
            className={primaryBtn}
            onClick={openNew}
            disabled={(workflows?.length ?? 0) >= maxWorkflows}
          >
            New workflow
          </button>
        </div>
      </div>

      {notice ? (
        <div className="mb-4 rounded-xl border border-brand/25 bg-brand-soft px-4 py-2.5 text-sm text-brand">
          {notice}
        </div>
      ) : null}
      {loadError ? (
        <div className="mb-4 rounded-xl2 border border-line bg-white p-6 text-center text-sm text-ink-2 shadow-card">
          Workflows could not be loaded. Refresh to try again.
        </div>
      ) : null}

      {generator ? (
        <WorkflowGenerator
          key={generator.current ? "change" : "new"}
          catalog={catalog}
          current={generator.current}
          canCreate={(workflows?.length ?? 0) < maxWorkflows}
          onOpen={openGenerated}
          onClose={() => setGenerator(null)}
        />
      ) : null}

      {/* ---------------------------------------------------------- editor */}
      {editor ? (
        <form
          onSubmit={saveEditor}
          className="mb-6 rounded-xl2 border border-line bg-white p-5 shadow-card"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-ink-2">Name</span>
                <input
                  className={inputClass + " mt-1"}
                  value={editor.name}
                  maxLength={80}
                  onChange={(event) => updateEditor({ name: event.target.value })}
                  placeholder="Refund request triage"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-ink-2">Description (optional)</span>
                <input
                  className={inputClass + " mt-1"}
                  value={editor.description}
                  maxLength={300}
                  onChange={(event) => updateEditor({ description: event.target.value })}
                  placeholder="What this workflow is for"
                />
              </label>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-line bg-white shadow-card p-1" aria-label="Zoom">
              {ZOOM_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={
                    "rounded-lg px-2 py-1 text-[11px] font-medium transition-colors duration-200 " +
                    (zoom === level ? "bg-white text-ink shadow-card" : "text-ink-3 hover:text-ink")
                  }
                  onClick={() => setZoom(level)}
                >
                  {Math.round(level * 100)}%
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <WorkflowCanvas
              steps={editor.steps}
              catalog={catalog}
              selected={selected}
              issues={issues}
              triggerTitle={triggerLabel(editor.triggerType)}
              triggerSubtitle={[
                editor.triggerType === "message_received" && editor.keyword.trim()
                  ? "keyword \u201c" + editor.keyword.trim() + "\u201d"
                  : "",
                editor.triggerType === "stage_changed" && editor.stage ? "stage " + editor.stage : "",
                editor.stopOnReply ? "stops on reply" : "",
              ]
                .filter(Boolean)
                .join(" \u00b7 ")}
              zoom={zoom}
              maxSteps={maxSteps}
              onSelect={setSelected}
              onReorder={(from, slot) => setSteps((steps) => moveToSlot(steps, from, slot))}
              onInsert={handleInsert}
              onRemove={handleRemove}
            />
            <aside className="rounded-xl2 border border-line bg-white shadow-card/60 p-4 lg:max-h-[70vh] lg:overflow-auto">
              {selectedStep && editor ? (
                <StepInspector
                  key={selectedStep.key}
                  step={selectedStep}
                  index={selectedIndex}
                  steps={editor.steps}
                  catalog={catalog}
                  issues={issues.get(selectedStep.key) ?? []}
                  onChange={(patch) => patchStep(selectedStep.key, patch)}
                  onKindChange={(kind) =>
                    setSteps((steps) =>
                      steps.map((step) => (step.key === selectedStep.key ? changeKind(step, kind) : step))
                    )
                  }
                  onRemove={() => handleRemove(selectedStep.key)}
                  onDuplicate={() => handleDuplicate(selectedStep.key)}
                  onMove={(direction) =>
                    setSteps((steps) => moveStep(steps, selectedIndex, selectedIndex + direction))
                  }
                />
              ) : selected === "trigger" ? (
                <TriggerInspector editor={editor} catalog={catalog} onChange={updateEditor} />
              ) : (
                <div className="text-xs text-ink-3">
                  <p className="text-sm font-semibold text-ink">Nothing selected</p>
                  <p className="mt-1">
                    Click the trigger or a step on the canvas to edit it. Drag the grip on a step to
                    reorder, or drag a node from the palette to add one.
                  </p>
                  <ul className="mt-3 space-y-1">
                    <li>Arrow keys move the selection.</li>
                    <li>Delete removes the selected step.</li>
                    <li>Esc clears the selection.</li>
                  </ul>
                </div>
              )}
            </aside>
          </div>

          {saveError ? (
            <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {saveError}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="submit" className={primaryBtn} disabled={saving}>
              {saving ? "Saving..." : editor.id ? "Save new version" : "Create draft"}
            </button>
            <button type="button" className={ghostBtn} onClick={changeWithAi}>
              <span aria-hidden className="mr-1 text-brand">{"\u2736"}</span>
              Change with AI
            </button>
            <button type="button" className={ghostBtn} onClick={() => setEditor(null)}>
              Cancel
            </button>
            <span className="text-[11px] text-ink-3">
              {editor.steps.length}/{maxSteps} steps
              {issues.size ? " \u00b7 " + issues.size + " need attention" : ""}
              {" \u00b7 "}Every save is versioned. New workflows start as drafts; activate them from the list.
            </span>
          </div>
        </form>
      ) : null}

      {/* ------------------------------------------------------------ list */}
      {workflows !== null && workflows.length === 0 && !editor ? (
        <div className="rounded-xl2 border border-line bg-white p-8 text-center shadow-card">
          <p className="text-sm font-medium text-ink">No workflows yet</p>
          <p className="mt-1 text-xs text-ink-3">
            Start from a template or build one from scratch. Workflows stay in draft
            until you activate them.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {(workflows ?? []).map((workflow) => {
          const busy = busyId === workflow.id;
          return (
            <div
              key={workflow.id}
              className="rounded-xl2 border border-line bg-white p-5 shadow-card"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{workflow.name}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {triggerLabel(workflow.triggerType)}
                    {typeof workflow.triggerConfig.keyword === "string" &&
                    workflow.triggerConfig.keyword
                      ? " \u00b7 keyword \u201c" + workflow.triggerConfig.keyword + "\u201d"
                      : ""}
                    {typeof workflow.triggerConfig.stage === "string" && workflow.triggerConfig.stage
                      ? " \u00b7 stage " + workflow.triggerConfig.stage
                      : ""}
                    {" \u00b7 "}
                    {workflow.stepCount} {workflow.stepCount === 1 ? "step" : "steps"}
                    {" \u00b7 v"}
                    {workflow.version}
                  </p>
                </div>
                <StatusChip status={workflow.status} />
              </div>
              {workflow.description ? (
                <p className="mt-2 text-xs leading-relaxed text-ink-2">{workflow.description}</p>
              ) : null}
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                {[
                  ["Runs", workflow.runs.total],
                  ["Live", workflow.runs.live],
                  ["Goals", workflow.runs.goals],
                  ["Failed", workflow.runs.failed],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-line bg-white shadow-card px-2 py-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-ink-3">{label}</p>
                    <p className="text-sm font-semibold text-ink">{value}</p>
                  </div>
                ))}
              </div>
              {workflow.runs.lastRunAt ? (
                <p className="mt-1.5 text-[11px] text-ink-3">
                  Last run {whenLabel(workflow.runs.lastRunAt)}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void openEdit(workflow)}>
                  Open in builder
                </button>
                {workflow.status === "active" ? (
                  <button type="button" className={ghostBtn} disabled={busy} onClick={() => void setStatus(workflow, "paused")}>
                    Pause
                  </button>
                ) : (
                  <button type="button" className={primaryBtn} disabled={busy || workflow.stepCount === 0} onClick={() => void setStatus(workflow, "active")}>
                    Activate
                  </button>
                )}
                <button
                  type="button"
                  className={ghostBtn}
                  disabled={busy}
                  onClick={() => {
                    setTestFor(testFor === workflow.id ? null : workflow.id);
                    setTestResult(null);
                  }}
                >
                  Run test
                </button>
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void openRuns(workflow)}>
                  Runs
                </button>
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void openVersions(workflow)}>
                  History
                </button>
                <button type="button" className={dangerBtn} disabled={busy} onClick={() => void archive(workflow)}>
                  Archive
                </button>
              </div>
              {testFor === workflow.id ? (
                <div className="mt-3 rounded-xl border border-line bg-white shadow-card p-3">
                  <p className="text-xs font-medium text-ink">Test with a real conversation</p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    The run starts immediately and stops at the first wait or approval.
                    Actions are real (messages are queued).
                  </p>
                  <div className="mt-2 flex gap-2">
                    <input
                      className={smallInput}
                      inputMode="numeric"
                      placeholder="Conversation id"
                      value={testConversation}
                      onChange={(event) => setTestConversation(event.target.value)}
                    />
                    <button type="button" className={primaryBtn} disabled={busy} onClick={() => void runTest(workflow)}>
                      Start
                    </button>
                  </div>
                  {testResult ? <p className="mt-2 text-xs text-ink-2">{testResult}</p> : null}
                </div>
              ) : null}
              {runsFor === workflow.id ? (
                <div className="mt-3 rounded-xl border border-line bg-white shadow-card p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-ink">Recent runs</p>
                    <button type="button" className="text-[11px] text-ink-3 hover:text-ink" onClick={() => setRunsFor(null)}>
                      Close
                    </button>
                  </div>
                  {runs === null ? (
                    <p className="mt-2 text-xs text-ink-3">Loading runs...</p>
                  ) : runs.length === 0 ? (
                    <p className="mt-2 text-xs text-ink-3">No runs yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {runs.map((run) => (
                        <li key={run.id} className="rounded-lg border border-line bg-white p-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-ink">
                              <span className="font-medium">#{run.id}</span>{" "}
                              {run.contactName || run.contactId || "unknown contact"}
                              {run.conversationId ? (
                                <a
                                  className="ml-1 text-brand hover:underline"
                                  href={"/dashboard/conversations/" + run.conversationId}
                                >
                                  open chat
                                </a>
                              ) : null}

              {versionsFor === workflow.id ? (
                <div className="mt-3 rounded-xl border border-line bg-white shadow-card p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-ink">Version history</p>
                    <button
                      type="button"
                      className="text-[11px] text-ink-3 hover:text-ink"
                      onClick={() => {
                        setVersionsFor(null);
                        setVersions(null);
                      }}
                    >
                      Close
                    </button>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    Every save is kept. Restore creates a new version from that snapshot.
                  </p>
                  {versions === null ? (
                    <p className="mt-2 text-xs text-ink-3">Loading versions...</p>
                  ) : versions.length === 0 ? (
                    <p className="mt-2 text-xs text-ink-3">No versions recorded yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {versions.map((entry) => (
                        <li
                          key={entry.version}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-white p-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-ink">
                              v{entry.version}
                              {entry.snapshot.restoredFrom
                                ? " · restored from v" + entry.snapshot.restoredFrom
                                : ""}
                            </p>
                            <p className="mt-0.5 truncate text-[11px] text-ink-3">
                              {entry.snapshot.name || "Untitled"}
                              {entry.snapshot.steps.length
                                ? " · " + entry.snapshot.steps.length + " steps"
                                : ""}
                              {entry.createdAt ? " · " + whenLabel(entry.createdAt) : ""}
                            </p>
                          </div>
                          <button
                            type="button"
                            className={ghostBtn}
                            disabled={busy}
                            onClick={() => void restoreVersion(workflow, entry.version)}
                          >
                            Restore
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

                            </p>
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-ink-3">{whenLabel(run.startedAt)}</span>
                              <StatusChip status={run.status} />
                            </div>
                          </div>
                          {run.goal ? (
                            <p className="mt-1 text-[11px] text-ok">Goal: {run.goal}</p>
                          ) : null}
                          {run.lastError && run.status === "failed" ? (
                            <p className="mt-1 text-[11px] text-rose-700">{run.lastError}</p>
                          ) : null}
                          {run.log.length ? (
                            <ol className="mt-1.5 space-y-0.5">
                              {run.log.map((line, index) => (
                                <li key={index} className="text-[11px] text-ink-2">
                                  <span className="text-ink-3">{line.stepNo > 0 ? "Step " + line.stepNo : "Trigger"}</span>
                                  {" \u00b7 "}
                                  {line.kind.replace(/_/g, " ")} {"\u2192"} {line.outcome.replace(/_/g, " ")}
                                  {line.detail ? <span className="text-ink-3"> ({line.detail})</span> : null}
                                </li>
                              ))}
                            </ol>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

    </div>
  );
}
