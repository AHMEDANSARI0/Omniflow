"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  PortalWorkflow,
  WorkflowCatalog,
  WorkflowRun,
  WorkflowStepKind,
} from "../../../../lib/omniflow/portal";

// ---------------------------------------------------------------------------
// Editor model (plain JSON - no canvas library; the D6 canvas builds on this)
// ---------------------------------------------------------------------------

interface Condition {
  field: string;
  op: string;
  value: string;
}

interface EditorStep {
  key: number;
  kind: WorkflowStepKind;
  label: string;
  // condition / branch
  group: "all" | "any";
  conditions: Condition[];
  elseMode: string; // stop | skip | continue | goto
  elseStep: string;
  // ai_decision
  question: string;
  fallback: "yes" | "no";
  // action
  action: string;
  args: Record<string, string>;
  argsJson: string;
  // wait
  waitAmount: string;
  waitUnit: "minutes" | "hours";
  // approval
  summary: string;
  // handoff
  userId: string;
  note: string;
  // goal
  goalName: string;
}

interface EditorState {
  id: number | null;
  name: string;
  description: string;
  triggerType: string;
  keyword: string;
  oncePerConversation: boolean;
  stage: string;
  stopOnReply: boolean;
  steps: EditorStep[];
}

const STEP_LABELS: Record<WorkflowStepKind, string> = {
  condition: "Condition",
  branch: "Branch",
  ai_decision: "AI decision",
  action: "Action",
  wait: "Wait",
  approval: "Approval",
  handoff: "Human handoff",
  goal: "Goal",
  stop: "Stop",
};

const STEP_HINTS: Record<WorkflowStepKind, string> = {
  condition: "Continue only when the rules match.",
  branch: "Like a condition, but jump to another step when it does not match.",
  ai_decision: "Ask the AI a yes/no question about the customer message.",
  action: "Run one action from the shared action registry.",
  wait: "Pause the run for a while (up to 7 days).",
  approval: "Ask the owner for a 1/0 approval on WhatsApp before continuing.",
  handoff: "Assign the conversation to a teammate.",
  goal: "Mark the run as a success and stop.",
  stop: "End the run here.",
};

const CONDITION_FIELDS = [
  { value: "keyword", label: "Message keyword" },
  { value: "intent", label: "Intent" },
  { value: "sentiment", label: "Sentiment" },
  { value: "language", label: "Language" },
  { value: "purchase_intent", label: "Purchase intent" },
  { value: "urgency", label: "Urgency" },
  { value: "stage", label: "Pipeline stage" },
  { value: "in_hours", label: "Business hours" },
  { value: "event", label: "Trigger event" },
];

const CONDITION_OPS = [
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "not_contains", label: "does not contain" },
  { value: "is", label: "is" },
  { value: "equals", label: "equals" },
  { value: "in_hours", label: "is true" },
];

const PIPELINE_STAGES = ["new", "interested", "negotiating", "won", "lost"];

const AUTO_ARGS = new Set(["contact_id", "conversation_id"]);
const ARG_LABELS: Record<string, string> = {
  body: "Message text",
  tag: "Tag",
  assignee: "Teammate email",
  agent_id: "Agent id",
  stage: "Stage",
  sequence_id: "Series id",
  content: "Note",
  query: "Search text",
  text: "Text",
  items: "Items (JSON)",
  note: "Note",
};

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";
const smallInput =
  "w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40";
const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";
const ghostBtn =
  "rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:border-line-2 hover:text-ink disabled:opacity-50";
const dangerBtn =
  "rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-medium text-rose-700 transition-colors duration-300 hover:bg-rose-50 disabled:opacity-50";

let stepKeySeed = 1;

function blankStep(kind: WorkflowStepKind = "action"): EditorStep {
  return {
    key: stepKeySeed++,
    kind,
    label: "",
    group: "all",
    conditions: [{ field: "keyword", op: "contains", value: "" }],
    elseMode: "stop",
    elseStep: "",
    question: "",
    fallback: "no",
    action: "queue_whatsapp_message",
    args: {},
    argsJson: "",
    waitAmount: "1",
    waitUnit: "hours",
    summary: "",
    userId: "",
    note: "",
    goalName: "",
  };
}

function blankEditor(): EditorState {
  return {
    id: null,
    name: "",
    description: "",
    triggerType: "message_received",
    keyword: "",
    oncePerConversation: true,
    stage: "",
    stopOnReply: false,
    steps: [blankStep()],
  };
}

function stepFromConfig(
  kind: WorkflowStepKind,
  label: string,
  config: Record<string, unknown>
): EditorStep {
  const step = blankStep(kind);
  step.label = label;
  if (kind === "condition" || kind === "branch") {
    const rules =
      config.rules && typeof config.rules === "object"
        ? (config.rules as Record<string, unknown>)
        : {};
    const anyList = Array.isArray(rules.any) ? rules.any : [];
    const allList = Array.isArray(rules.all) ? rules.all : [];
    const source = anyList.length && !allList.length ? anyList : allList;
    step.group = anyList.length && !allList.length ? "any" : "all";
    step.conditions = source.length
      ? source.map((raw) => {
          const item = (raw ?? {}) as Record<string, unknown>;
          return {
            field: typeof item.field === "string" ? item.field : "keyword",
            op: typeof item.op === "string" ? item.op : "contains",
            value: item.value === undefined || item.value === null ? "" : String(item.value),
          };
        })
      : step.conditions;
    const elseValue = config.else;
    if (typeof elseValue === "number") {
      step.elseMode = "goto";
      step.elseStep = String(elseValue);
    } else if (typeof elseValue === "string") {
      step.elseMode = elseValue;
    }
  } else if (kind === "ai_decision") {
    step.question = typeof config.question === "string" ? config.question : "";
    step.fallback = config.fallback === "yes" ? "yes" : "no";
    const elseValue = config.else;
    if (typeof elseValue === "number") {
      step.elseMode = "goto";
      step.elseStep = String(elseValue);
    } else if (typeof elseValue === "string") {
      step.elseMode = elseValue;
    }
  } else if (kind === "action") {
    step.action = typeof config.action === "string" ? config.action : "";
    const args =
      config.args && typeof config.args === "object"
        ? (config.args as Record<string, unknown>)
        : {};
    const simple: Record<string, string> = {};
    const advanced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" || typeof value === "number") {
        simple[key] = String(value);
      } else {
        advanced[key] = value;
      }
    }
    step.args = simple;
    step.argsJson = Object.keys(advanced).length ? JSON.stringify(advanced) : "";
  } else if (kind === "wait") {
    const minutes = typeof config.minutes === "number" ? config.minutes : 60;
    if (minutes % 60 === 0) {
      step.waitAmount = String(minutes / 60);
      step.waitUnit = "hours";
    } else {
      step.waitAmount = String(minutes);
      step.waitUnit = "minutes";
    }
  } else if (kind === "approval") {
    step.summary = typeof config.summary === "string" ? config.summary : "";
  } else if (kind === "handoff") {
    step.userId = typeof config.user_id === "number" ? String(config.user_id) : "";
    step.note = typeof config.note === "string" ? config.note : "";
  } else if (kind === "goal") {
    step.goalName = typeof config.name === "string" ? config.name : "";
  }
  return step;
}

function editorFromWorkflow(workflow: PortalWorkflow): EditorState {
  const trigger = workflow.triggerConfig;
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    triggerType: workflow.triggerType,
    keyword: typeof trigger.keyword === "string" ? trigger.keyword : "",
    oncePerConversation: trigger.once_per_conversation !== false,
    stage: typeof trigger.stage === "string" ? trigger.stage : "",
    stopOnReply: workflow.stopOnReply,
    steps: workflow.steps.length
      ? workflow.steps.map((step) => stepFromConfig(step.kind, step.label, step.config))
      : [blankStep()],
  };
}

function editorFromTemplate(
  template: WorkflowCatalog["templates"][number]
): EditorState {
  const trigger = template.triggerConfig;
  return {
    id: null,
    name: template.name,
    description: template.description,
    triggerType: template.triggerType,
    keyword: typeof trigger.keyword === "string" ? trigger.keyword : "",
    oncePerConversation: trigger.once_per_conversation !== false,
    stage: typeof trigger.stage === "string" ? trigger.stage : "",
    stopOnReply: template.stopOnReply,
    steps: template.steps.map((step) => stepFromConfig(step.kind, step.label, step.config)),
  };
}

function elseValue(step: EditorStep): string | number {
  if (step.elseMode === "goto") {
    const parsed = Number.parseInt(step.elseStep, 10);
    return Number.isFinite(parsed) ? parsed : "stop";
  }
  return step.elseMode || "stop";
}

function stepConfig(step: EditorStep): Record<string, unknown> {
  switch (step.kind) {
    case "condition":
    case "branch": {
      const list = step.conditions
        .filter((c) => c.field)
        .map((c) => ({ field: c.field, op: c.op, value: c.value.trim() }));
      return { rules: { [step.group]: list }, else: elseValue(step) };
    }
    case "ai_decision":
      return { question: step.question.trim(), fallback: step.fallback, else: elseValue(step) };
    case "action": {
      let advanced: Record<string, unknown> = {};
      if (step.argsJson.trim()) {
        try {
          const parsed = JSON.parse(step.argsJson) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            advanced = parsed as Record<string, unknown>;
          }
        } catch {
          advanced = { __invalid_json: true };
        }
      }
      const args: Record<string, unknown> = { ...advanced };
      for (const [key, value] of Object.entries(step.args)) {
        if (value.trim()) args[key] = /^\d+$/.test(value.trim()) && key.endsWith("_id") ? Number.parseInt(value, 10) : value;
      }
      return { action: step.action, args };
    }
    case "wait": {
      const amount = Number.parseFloat(step.waitAmount) || 0;
      return step.waitUnit === "hours" ? { hours: amount } : { minutes: Math.round(amount) };
    }
    case "approval":
      return { summary: step.summary.trim() };
    case "handoff": {
      const config: Record<string, unknown> = {};
      const parsed = Number.parseInt(step.userId, 10);
      if (Number.isFinite(parsed) && parsed > 0) config.user_id = parsed;
      if (step.note.trim()) config.note = step.note.trim();
      return config;
    }
    case "goal":
      return { name: step.goalName.trim() };
    default:
      return {};
  }
}

function editorPayload(state: EditorState) {
  const triggerConfig: Record<string, unknown> = {};
  if (state.triggerType === "message_received") {
    if (state.keyword.trim()) triggerConfig.keyword = state.keyword.trim();
    triggerConfig.once_per_conversation = state.oncePerConversation;
  }
  if (state.triggerType === "stage_changed" && state.stage) {
    triggerConfig.stage = state.stage;
  }
  return {
    name: state.name.trim(),
    description: state.description.trim(),
    trigger_type: state.triggerType,
    trigger_config: triggerConfig,
    stop_on_reply: state.stopOnReply,
    steps: state.steps.map((step) => ({
      kind: step.kind,
      label: step.label.trim() || STEP_LABELS[step.kind],
      config: stepConfig(step),
    })),
  };
}

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
  const label = status.replace(/_/g, " ");
  return (
    <span
      className={
        "rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize " +
        (styles[status] || "border-line-2 bg-soft text-ink-3")
      }
    >
      {label}
    </span>
  );
}

function RiskChip({ risk }: { risk: string }) {
  const styles: Record<string, string> = {
    low: "text-ink-3 border-line-2",
    medium: "text-amber-700 border-amber-300/40",
    high: "text-rose-700 border-rose-200",
  };
  return (
    <span
      className={
        "rounded-full border px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide " +
        (styles[risk] || styles.low)
      }
    >
      {risk}
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [runsFor, setRunsFor] = useState<number | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [testFor, setTestFor] = useState<number | null>(null);
  const [testConversation, setTestConversation] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState("");

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

  const actionsByName = useMemo(() => {
    const map = new Map<string, WorkflowCatalog["actions"][number]>();
    for (const action of catalog?.actions ?? []) map.set(action.action, action);
    return map;
  }, [catalog]);

  // ----- editor actions -----

  function openNew() {
    setSaveError(null);
    setEditor(blankEditor());
    setTemplateKey("");
  }

  function openTemplate(key: string) {
    setTemplateKey(key);
    const template = catalog?.templates.find((t) => t.key === key);
    if (!template) return;
    setSaveError(null);
    setEditor(editorFromTemplate(template));
  }

  async function openEdit(workflow: PortalWorkflow) {
    setSaveError(null);
    setBusyId(workflow.id);
    try {
      const response = await fetch("/api/omniflow/portal/workflows/" + workflow.id, {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as { workflow?: PortalWorkflow };
        if (payload.workflow) setEditor(editorFromWorkflow(payload.workflow));
      } else {
        flash("Could not open that workflow.");
      }
    } catch {
      flash("Could not open that workflow.");
    } finally {
      setBusyId(null);
    }
  }

  function updateEditor(patch: Partial<EditorState>) {
    setEditor((current) => (current ? { ...current, ...patch } : current));
  }

  function updateStep(key: number, patch: Partial<EditorStep>) {
    setEditor((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step) =>
              step.key === key ? { ...step, ...patch } : step
            ),
          }
        : current
    );
  }

  function moveStep(index: number, direction: -1 | 1) {
    setEditor((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      const [item] = steps.splice(index, 1);
      steps.splice(target, 0, item);
      return { ...current, steps };
    });
  }

  function removeStep(key: number) {
    setEditor((current) =>
      current ? { ...current, steps: current.steps.filter((s) => s.key !== key) } : current
    );
  }

  function addStep(kind: WorkflowStepKind) {
    setEditor((current) => {
      if (!current) return current;
      if (current.steps.length >= (catalog?.limits.maxSteps ?? 12)) return current;
      return { ...current, steps: [...current.steps, blankStep(kind)] };
    });
  }

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
    const payload = editorPayload(editor);
    if (payload.steps.some((s) => (s.config.args as Record<string, unknown> | undefined)?.__invalid_json)) {
      setSaveError("Advanced arguments must be valid JSON.");
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
          body: JSON.stringify(payload),
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
  const maxWorkflows = catalog?.limits.maxWorkflows ?? 20;

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
            className={smallInput + " w-auto min-w-[190px]"}
            value={templateKey}
            onChange={(event) => openTemplate(event.target.value)}
            aria-label="Start from template"
          >
            <option value="">Start from template</option>
            {(catalog?.templates ?? []).map((template) => (
              <option key={template.key} value={template.key}>
                {template.name}
              </option>
            ))}
          </select>
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
                      ? " · keyword \"" + workflow.triggerConfig.keyword + "\""
                      : ""}
                    {typeof workflow.triggerConfig.stage === "string" && workflow.triggerConfig.stage
                      ? " · stage " + workflow.triggerConfig.stage
                      : ""}
                    {" · "}
                    {workflow.stepCount} {workflow.stepCount === 1 ? "step" : "steps"} · v
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
                  <div key={String(label)} className="rounded-xl border border-line bg-soft px-2 py-1.5">
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
                  Edit
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
                <button type="button" className={dangerBtn} disabled={busy} onClick={() => void archive(workflow)}>
                  Archive
                </button>
              </div>
              {testFor === workflow.id ? (
                <div className="mt-3 rounded-xl border border-line bg-soft p-3">
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
                <div className="mt-3 rounded-xl border border-line bg-soft p-3">
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
                                  {" · "}
                                  {line.kind.replace(/_/g, " ")} → {line.outcome.replace(/_/g, " ")}
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

      {/* ---------------------------------------------------------- editor */}
      {editor ? (
        <form
          onSubmit={saveEditor}
          className="mt-6 rounded-xl2 border border-line bg-white p-5 shadow-card"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">
              {editor.id ? "Edit workflow" : "New workflow"}
            </h2>
            <button type="button" className="text-xs text-ink-3 hover:text-ink" onClick={() => setEditor(null)}>
              Cancel
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
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

          <div className="mt-4 rounded-xl border border-line bg-soft p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Trigger</p>
            <div className="mt-2 grid gap-3 md:grid-cols-3">
              <label className="block">
                <span className="text-xs font-medium text-ink-2">When</span>
                <select
                  className={inputClass + " mt-1"}
                  value={editor.triggerType}
                  onChange={(event) => updateEditor({ triggerType: event.target.value })}
                >
                  {(catalog?.triggers ?? [{ trigger: editor.triggerType, label: editor.triggerType, source: "", options: [], description: "" }]).map((trigger) => (
                    <option key={trigger.trigger} value={trigger.trigger}>
                      {trigger.label}
                    </option>
                  ))}
                </select>
              </label>
              {editor.triggerType === "message_received" ? (
                <>
                  <label className="block">
                    <span className="text-xs font-medium text-ink-2">Keyword (optional, whole word)</span>
                    <input
                      className={inputClass + " mt-1"}
                      value={editor.keyword}
                      maxLength={32}
                      onChange={(event) => updateEditor({ keyword: event.target.value })}
                      placeholder="refund"
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-2.5 text-xs text-ink-2">
                    <input
                      type="checkbox"
                      checked={editor.oncePerConversation}
                      onChange={(event) => updateEditor({ oncePerConversation: event.target.checked })}
                    />
                    Only once per conversation
                  </label>
                </>
              ) : null}
              {editor.triggerType === "stage_changed" ? (
                <label className="block">
                  <span className="text-xs font-medium text-ink-2">Stage (optional)</span>
                  <select
                    className={inputClass + " mt-1"}
                    value={editor.stage}
                    onChange={(event) => updateEditor({ stage: event.target.value })}
                  >
                    <option value="">Any stage</option>
                    {PIPELINE_STAGES.map((stage) => (
                      <option key={stage} value={stage}>
                        {stage}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <p className="mt-2 text-[11px] text-ink-3">
              {catalog?.triggers.find((t) => t.trigger === editor.triggerType)?.description ?? ""}
            </p>
            <label className="mt-3 flex items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={editor.stopOnReply}
                onChange={(event) => updateEditor({ stopOnReply: event.target.checked })}
              />
              Stop waiting runs when the customer replies (stop_on_reply)
            </label>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">
                Steps ({editor.steps.length}/{catalog?.limits.maxSteps ?? 12})
              </p>
            </div>
            <ol className="mt-2 space-y-3">
              {editor.steps.map((step, index) => {
                const spec = actionsByName.get(step.action);
                const requiredArgs = (spec?.required ?? []).filter((arg) => !AUTO_ARGS.has(arg));
                const showBody = step.action === "queue_whatsapp_message" || step.action === "add_customer_note";
                return (
                  <li key={step.key} className="rounded-xl border border-line bg-white p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-brand/25 bg-brand-soft text-[11px] font-semibold text-brand">
                        {index + 1}
                      </span>
                      <select
                        className={smallInput + " w-auto"}
                        value={step.kind}
                        onChange={(event) => updateStep(step.key, { kind: event.target.value as WorkflowStepKind })}
                      >
                        {(Object.keys(STEP_LABELS) as WorkflowStepKind[]).map((kind) => (
                          <option key={kind} value={kind}>
                            {STEP_LABELS[kind]}
                          </option>
                        ))}
                      </select>
                      <input
                        className={smallInput + " max-w-[220px]"}
                        value={step.label}
                        maxLength={60}
                        placeholder="Label (optional)"
                        onChange={(event) => updateStep(step.key, { label: event.target.value })}
                      />
                      <span className="ml-auto flex items-center gap-1">
                        <button type="button" className={ghostBtn} disabled={index === 0} onClick={() => moveStep(index, -1)} aria-label="Move up">
                          Up
                        </button>
                        <button type="button" className={ghostBtn} disabled={index === editor.steps.length - 1} onClick={() => moveStep(index, 1)} aria-label="Move down">
                          Down
                        </button>
                        <button type="button" className={dangerBtn} onClick={() => removeStep(step.key)}>
                          Remove
                        </button>
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-ink-3">{STEP_HINTS[step.kind]}</p>

                    {/* per-kind config */}
                    {step.kind === "condition" || step.kind === "branch" ? (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs text-ink-2">
                          Match
                          <select
                            className={smallInput + " w-auto"}
                            value={step.group}
                            onChange={(event) => updateStep(step.key, { group: event.target.value as "all" | "any" })}
                          >
                            <option value="all">all</option>
                            <option value="any">any</option>
                          </select>
                          of these rules
                        </div>
                        {step.conditions.map((condition, cIndex) => (
                          <div key={cIndex} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                            <select
                              className={smallInput}
                              value={condition.field}
                              onChange={(event) => {
                                const conditions = step.conditions.map((c, i) =>
                                  i === cIndex ? { ...c, field: event.target.value } : c
                                );
                                updateStep(step.key, { conditions });
                              }}
                            >
                              {CONDITION_FIELDS.map((field) => (
                                <option key={field.value} value={field.value}>
                                  {field.label}
                                </option>
                              ))}
                            </select>
                            <select
                              className={smallInput}
                              value={condition.op}
                              onChange={(event) => {
                                const conditions = step.conditions.map((c, i) =>
                                  i === cIndex ? { ...c, op: event.target.value } : c
                                );
                                updateStep(step.key, { conditions });
                              }}
                            >
                              {CONDITION_OPS.map((op) => (
                                <option key={op.value} value={op.value}>
                                  {op.label}
                                </option>
                              ))}
                            </select>
                            <input
                              className={smallInput}
                              value={condition.value}
                              placeholder={condition.op === "in_hours" ? "(no value)" : "value"}
                              disabled={condition.op === "in_hours"}
                              onChange={(event) => {
                                const conditions = step.conditions.map((c, i) =>
                                  i === cIndex ? { ...c, value: event.target.value } : c
                                );
                                updateStep(step.key, { conditions });
                              }}
                            />
                            <button
                              type="button"
                              className={ghostBtn}
                              disabled={step.conditions.length === 1}
                              onClick={() =>
                                updateStep(step.key, {
                                  conditions: step.conditions.filter((_, i) => i !== cIndex),
                                })
                              }
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className={ghostBtn}
                            disabled={step.conditions.length >= 10}
                            onClick={() =>
                              updateStep(step.key, {
                                conditions: [...step.conditions, { field: "keyword", op: "contains", value: "" }],
                              })
                            }
                          >
                            Add rule
                          </button>
                          <ElseControl step={step} total={editor.steps.length} onChange={(patch) => updateStep(step.key, patch)} />
                        </div>
                      </div>
                    ) : null}

                    {step.kind === "ai_decision" ? (
                      <div className="mt-3 space-y-2">
                        <textarea
                          className={inputClass}
                          rows={2}
                          maxLength={300}
                          value={step.question}
                          placeholder="Is the customer asking for a refund on a paid order?"
                          onChange={(event) => updateStep(step.key, { question: event.target.value })}
                        />
                        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
                          <label className="flex items-center gap-2">
                            If the AI is unavailable, assume
                            <select
                              className={smallInput + " w-auto"}
                              value={step.fallback}
                              onChange={(event) => updateStep(step.key, { fallback: event.target.value as "yes" | "no" })}
                            >
                              <option value="no">no</option>
                              <option value="yes">yes</option>
                            </select>
                          </label>
                          <ElseControl step={step} total={editor.steps.length} onChange={(patch) => updateStep(step.key, patch)} label="When the answer is no" />
                        </div>
                      </div>
                    ) : null}

                    {step.kind === "action" ? (
                      <div className="mt-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            className={smallInput + " w-auto min-w-[240px]"}
                            value={step.action}
                            onChange={(event) => updateStep(step.key, { action: event.target.value, args: {} })}
                          >
                            {(catalog?.actions ?? []).map((action) => (
                              <option key={action.action} value={action.action}>
                                {action.description}
                              </option>
                            ))}
                          </select>
                          {spec ? <RiskChip risk={spec.risk} /> : null}
                          {spec?.risk === "high" ? (
                            <span className="text-[11px] text-ink-3">Pauses for owner approval.</span>
                          ) : null}
                        </div>
                        {requiredArgs.length || showBody ? (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {requiredArgs.map((arg) =>
                              arg === "body" || arg === "content" ? (
                                <label key={arg} className="block sm:col-span-2">
                                  <span className="text-[11px] font-medium text-ink-2">
                                    {ARG_LABELS[arg] ?? arg}
                                    <span className="text-ink-3"> · placeholders: {"{first_name} {name} {text} {stage}"}</span>
                                  </span>
                                  <textarea
                                    className={inputClass + " mt-1"}
                                    rows={2}
                                    maxLength={1000}
                                    value={step.args[arg] ?? ""}
                                    onChange={(event) => updateStep(step.key, { args: { ...step.args, [arg]: event.target.value } })}
                                  />
                                </label>
                              ) : arg === "stage" ? (
                                <label key={arg} className="block">
                                  <span className="text-[11px] font-medium text-ink-2">{ARG_LABELS[arg]}</span>
                                  <select
                                    className={smallInput + " mt-1"}
                                    value={step.args[arg] ?? ""}
                                    onChange={(event) => updateStep(step.key, { args: { ...step.args, [arg]: event.target.value } })}
                                  >
                                    <option value="">Pick a stage</option>
                                    {PIPELINE_STAGES.map((stage) => (
                                      <option key={stage} value={stage}>
                                        {stage}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              ) : (
                                <label key={arg} className="block">
                                  <span className="text-[11px] font-medium text-ink-2">{ARG_LABELS[arg] ?? arg}</span>
                                  <input
                                    className={smallInput + " mt-1"}
                                    value={step.args[arg] ?? ""}
                                    onChange={(event) => updateStep(step.key, { args: { ...step.args, [arg]: event.target.value } })}
                                  />
                                </label>
                              )
                            )}
                          </div>
                        ) : null}
                        <details>
                          <summary className="cursor-pointer text-[11px] text-ink-3">Advanced arguments (JSON)</summary>
                          <textarea
                            className={inputClass + " mt-1 font-mono text-xs"}
                            rows={2}
                            value={step.argsJson}
                            placeholder='{"discount": 0}'
                            onChange={(event) => updateStep(step.key, { argsJson: event.target.value })}
                          />
                        </details>
                        <p className="text-[11px] text-ink-3">
                          Contact and conversation are filled in from the run automatically.
                        </p>
                      </div>
                    ) : null}

                    {step.kind === "wait" ? (
                      <div className="mt-3 flex items-center gap-2 text-xs text-ink-2">
                        Wait
                        <input
                          className={smallInput + " w-24"}
                          inputMode="decimal"
                          value={step.waitAmount}
                          onChange={(event) => updateStep(step.key, { waitAmount: event.target.value })}
                        />
                        <select
                          className={smallInput + " w-auto"}
                          value={step.waitUnit}
                          onChange={(event) => updateStep(step.key, { waitUnit: event.target.value as "minutes" | "hours" })}
                        >
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                        </select>
                        <span className="text-ink-3">(max 7 days)</span>
                      </div>
                    ) : null}

                    {step.kind === "approval" ? (
                      <input
                        className={inputClass + " mt-3"}
                        maxLength={200}
                        value={step.summary}
                        placeholder="What you are approving, e.g. Send {first_name} a 10% discount"
                        onChange={(event) => updateStep(step.key, { summary: event.target.value })}
                      />
                    ) : null}

                    {step.kind === "handoff" ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <label className="block">
                          <span className="text-[11px] font-medium text-ink-2">Teammate user id (blank = first teammate)</span>
                          <input
                            className={smallInput + " mt-1"}
                            inputMode="numeric"
                            value={step.userId}
                            onChange={(event) => updateStep(step.key, { userId: event.target.value })}
                          />
                        </label>
                        <label className="block">
                          <span className="text-[11px] font-medium text-ink-2">Note for the team (optional)</span>
                          <input
                            className={smallInput + " mt-1"}
                            maxLength={160}
                            value={step.note}
                            onChange={(event) => updateStep(step.key, { note: event.target.value })}
                          />
                        </label>
                      </div>
                    ) : null}

                    {step.kind === "goal" ? (
                      <input
                        className={inputClass + " mt-3"}
                        maxLength={80}
                        value={step.goalName}
                        placeholder="Goal name, e.g. review_requested"
                        onChange={(event) => updateStep(step.key, { goalName: event.target.value })}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-3">Add step:</span>
              {(Object.keys(STEP_LABELS) as WorkflowStepKind[])
                .filter((kind) => kind !== "branch")
                .map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={ghostBtn}
                    disabled={editor.steps.length >= (catalog?.limits.maxSteps ?? 12)}
                    onClick={() => addStep(kind)}
                  >
                    {STEP_LABELS[kind]}
                  </button>
                ))}
            </div>
          </div>

          {saveError ? (
            <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {saveError}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-2">
            <button type="submit" className={primaryBtn} disabled={saving}>
              {saving ? "Saving..." : editor.id ? "Save new version" : "Create draft"}
            </button>
            <button type="button" className={ghostBtn} onClick={() => setEditor(null)}>
              Cancel
            </button>
            <span className="text-[11px] text-ink-3">
              Every save is versioned. New workflows start as drafts; activate them from the list.
            </span>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ElseControl({
  step,
  total,
  onChange,
  label = "When it does not match",
}: {
  step: EditorStep;
  total: number;
  onChange: (patch: Partial<EditorStep>) => void;
  label?: string;
}) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
      {label}
      <select
        className={smallInput + " w-auto"}
        value={step.elseMode}
        onChange={(event) => onChange({ elseMode: event.target.value })}
      >
        <option value="stop">stop the run</option>
        <option value="skip">skip the next step</option>
        <option value="continue">continue anyway</option>
        <option value="goto">jump to step</option>
      </select>
      {step.elseMode === "goto" ? (
        <input
          className={smallInput + " w-16"}
          inputMode="numeric"
          min={1}
          max={total}
          value={step.elseStep}
          placeholder="#"
          onChange={(event) => onChange({ elseStep: event.target.value })}
        />
      ) : null}
    </label>
  );
}
