/**
 * Workflow builder model - PURE functions, no React, no DOM.
 *
 * The canvas, the inspector and the list page all share this file, and
 * the rig executes it directly with Node (type-stripping) against the
 * Control Plane's own templates, so the editor <-> API contract is
 * tested, not assumed. Keep it dependency-free and erasable-TS only
 * (no enums / namespaces / parameter properties).
 */
import type {
  PortalWorkflow,
  WorkflowCatalog,
  WorkflowStepKind,
  WorkflowTemplate,
} from "../../../../lib/omniflow/portal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Condition {
  field: string;
  op: string;
  value: string;
}

export type ElseMode = "stop" | "skip" | "continue" | "goto";

export interface EditorStep {
  /** Stable identity - jump targets reference keys, never positions. */
  key: number;
  kind: WorkflowStepKind;
  label: string;
  // condition / branch
  group: "all" | "any";
  conditions: Condition[];
  elseMode: ElseMode;
  /** key of the step to jump to when elseMode === "goto" */
  elseTarget: number | null;
  /** branch only: key of the step to jump to when the rules match */
  thenTarget: number | null;
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

export interface EditorState {
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

export interface DefinitionStep {
  kind: WorkflowStepKind;
  label: string;
  config: Record<string, unknown>;
}

export interface WorkflowPayload {
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  stop_on_reply: boolean;
  steps: { kind: string; label: string; config: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// Vocabulary (labels are UI copy; keys mirror the Control Plane)
// ---------------------------------------------------------------------------

export const STEP_LABELS: Record<WorkflowStepKind, string> = {
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

export const STEP_HINTS: Record<WorkflowStepKind, string> = {
  condition: "Continue only when the rules match.",
  branch: "Two-way split: jump to different steps when the rules match or not.",
  ai_decision: "Ask the AI a yes/no question about the customer message.",
  action: "Run one action from the shared action registry.",
  wait: "Pause the run for a while (up to 7 days).",
  approval: "Ask the owner for a 1/0 approval on WhatsApp before continuing.",
  handoff: "Assign the conversation to a teammate.",
  goal: "Mark the run as a success and stop.",
  stop: "End the run here.",
};

/** Palette order (D6 node set). */
export const NODE_KINDS: WorkflowStepKind[] = [
  "condition",
  "branch",
  "ai_decision",
  "action",
  "wait",
  "approval",
  "handoff",
  "goal",
  "stop",
];

/** Kinds that split the flow (have a "no" exit). */
export const DECISION_KINDS: WorkflowStepKind[] = ["condition", "branch", "ai_decision"];
/** Kinds that end the run. */
export const TERMINAL_KINDS: WorkflowStepKind[] = ["goal", "stop"];

export const CONDITION_FIELDS: { value: string; label: string }[] = [
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

export const CONDITION_OPS: { value: string; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "not_contains", label: "does not contain" },
  { value: "is", label: "is" },
  { value: "equals", label: "equals" },
  { value: "in_hours", label: "is true" },
];

export const PIPELINE_STAGES: string[] = ["new", "interested", "negotiating", "won", "lost"];

export const AUTO_ARGS: string[] = ["contact_id", "conversation_id"];

export const ARG_LABELS: Record<string, string> = {
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

export const MAX_WAIT_MINUTES_DEFAULT = 10080;
export const MAX_STEPS_DEFAULT = 12;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

let stepKeySeed = 1;

export function nextKey(): number {
  return stepKeySeed++;
}

export function blankStep(kind: WorkflowStepKind = "action"): EditorStep {
  return {
    key: nextKey(),
    kind,
    label: "",
    group: "all",
    conditions: [{ field: "keyword", op: "contains", value: "" }],
    elseMode: "stop",
    elseTarget: null,
    thenTarget: null,
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

export function blankEditor(): EditorState {
  return {
    id: null,
    name: "",
    description: "",
    triggerType: "message_received",
    keyword: "",
    oncePerConversation: true,
    stage: "",
    stopOnReply: false,
    steps: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stepFromConfig(
  kind: WorkflowStepKind,
  label: string,
  config: Record<string, unknown>
): { step: EditorStep; elseNo: number | null; thenNo: number | null } {
  const step = blankStep(kind);
  step.label = label;
  let elseNo: number | null = null;
  let thenNo: number | null = null;
  if (kind === "condition" || kind === "branch") {
    const rules = asRecord(config.rules);
    const anyList = Array.isArray(rules.any) ? rules.any : [];
    const allList = Array.isArray(rules.all) ? rules.all : [];
    const useAny = anyList.length > 0 && allList.length === 0;
    const source = useAny ? anyList : allList;
    step.group = useAny ? "any" : "all";
    if (source.length) {
      step.conditions = source.map((raw) => {
        const item = asRecord(raw);
        return {
          field: typeof item.field === "string" ? item.field : "keyword",
          op: typeof item.op === "string" ? item.op : "contains",
          value:
            item.value === undefined || item.value === null ? "" : String(item.value),
        };
      });
    }
    const elseValue = config.else;
    if (typeof elseValue === "number") {
      step.elseMode = "goto";
      elseNo = elseValue;
    } else if (elseValue === "skip" || elseValue === "continue" || elseValue === "stop") {
      step.elseMode = elseValue;
    }
    if (typeof config.then === "number") thenNo = config.then;
  } else if (kind === "ai_decision") {
    step.question = typeof config.question === "string" ? config.question : "";
    step.fallback = config.fallback === "yes" ? "yes" : "no";
    const elseValue = config.else;
    if (typeof elseValue === "number") {
      step.elseMode = "goto";
      elseNo = elseValue;
    } else if (elseValue === "skip" || elseValue === "continue" || elseValue === "stop") {
      step.elseMode = elseValue;
    }
  } else if (kind === "action") {
    step.action = typeof config.action === "string" ? config.action : "";
    const args = asRecord(config.args);
    const simple: Record<string, string> = {};
    const advanced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" || typeof value === "number") simple[key] = String(value);
      else advanced[key] = value;
    }
    step.args = simple;
    step.argsJson = Object.keys(advanced).length ? JSON.stringify(advanced) : "";
  } else if (kind === "wait") {
    let minutes = typeof config.minutes === "number" ? config.minutes : 0;
    if (typeof config.hours === "number") minutes += Math.round(config.hours * 60);
    if (minutes <= 0) minutes = 60;
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
  return { step, elseNo, thenNo };
}

/** Definition steps (API shape) -> editor steps with key-based jumps. */
export function stepsFromDefinition(definition: DefinitionStep[]): EditorStep[] {
  const built = definition.map((item) =>
    stepFromConfig(item.kind, item.label, asRecord(item.config))
  );
  const keyAt = (no: number | null): number | null =>
    no !== null && no >= 1 && no <= built.length ? built[no - 1].step.key : null;
  return built.map(({ step, elseNo, thenNo }) => {
    if (step.elseMode === "goto") {
      const target = keyAt(elseNo);
      step.elseTarget = target;
      if (target === null || target === step.key) step.elseMode = "stop";
    }
    step.thenTarget = keyAt(thenNo);
    if (step.thenTarget === step.key) step.thenTarget = null;
    return step;
  });
}

export function editorFromWorkflow(workflow: PortalWorkflow): EditorState {
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
    steps: stepsFromDefinition(
      workflow.steps.map((step) => ({
        kind: step.kind,
        label: step.label,
        config: step.config,
      }))
    ),
  };
}

export function editorFromTemplate(template: WorkflowTemplate): EditorState {
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
    steps: stepsFromDefinition(template.steps),
  };
}

// ---------------------------------------------------------------------------
// Serialisation (editor -> API payload)
// ---------------------------------------------------------------------------

function stepNo(steps: EditorStep[], key: number | null): number | null {
  if (key === null) return null;
  const index = steps.findIndex((step) => step.key === key);
  return index >= 0 ? index + 1 : null;
}

function elseValue(step: EditorStep, steps: EditorStep[]): string | number {
  if (step.elseMode === "goto") {
    const target = stepNo(steps, step.elseTarget);
    return target !== null && target !== stepNo(steps, step.key) ? target : "stop";
  }
  return step.elseMode;
}

export function waitMinutes(step: EditorStep): number {
  const amount = Number.parseFloat(step.waitAmount);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(step.waitUnit === "hours" ? amount * 60 : amount);
}

export function parseAdvancedArgs(step: EditorStep): Record<string, unknown> | null {
  if (!step.argsJson.trim()) return {};
  try {
    const parsed = JSON.parse(step.argsJson) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stepConfig(step: EditorStep, steps: EditorStep[]): Record<string, unknown> {
  switch (step.kind) {
    case "condition":
    case "branch": {
      const list = step.conditions
        .filter((c) => c.field)
        .map((c) => ({ field: c.field, op: c.op, value: c.value.trim() }));
      const config: Record<string, unknown> = {
        rules: { [step.group]: list },
        else: elseValue(step, steps),
      };
      const then = stepNo(steps, step.thenTarget);
      if (step.kind === "branch" && then !== null && then !== stepNo(steps, step.key)) {
        config.then = then;
      }
      return config;
    }
    case "ai_decision":
      return {
        question: step.question.trim(),
        fallback: step.fallback,
        else: elseValue(step, steps),
      };
    case "action": {
      const args: Record<string, unknown> = { ...(parseAdvancedArgs(step) ?? {}) };
      for (const [key, value] of Object.entries(step.args)) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        args[key] = key.endsWith("_id") && /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : value;
      }
      return { action: step.action, args };
    }
    case "wait":
      return { minutes: waitMinutes(step) };
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

export function editorPayload(state: EditorState): WorkflowPayload {
  const triggerConfig: Record<string, unknown> = {};
  if (state.triggerType === "message_received") {
    if (state.keyword.trim()) triggerConfig.keyword = state.keyword.trim();
    triggerConfig.once_per_conversation = state.oncePerConversation;
  }
  if (state.triggerType === "stage_changed" && state.stage) triggerConfig.stage = state.stage;
  return {
    name: state.name.trim(),
    description: state.description.trim(),
    trigger_type: state.triggerType,
    trigger_config: triggerConfig,
    stop_on_reply: state.stopOnReply,
    steps: state.steps.map((step) => ({
      kind: step.kind,
      label: step.label.trim() || STEP_LABELS[step.kind],
      config: stepConfig(step, state.steps),
    })),
  };
}

// ---------------------------------------------------------------------------
// Editing helpers (pure - return new arrays, keys stay stable)
// ---------------------------------------------------------------------------

export function insertStep(
  steps: EditorStep[],
  index: number,
  kind: WorkflowStepKind
): { steps: EditorStep[]; key: number } {
  const step = blankStep(kind);
  const at = Math.max(0, Math.min(steps.length, index));
  return { steps: [...steps.slice(0, at), step, ...steps.slice(at)], key: step.key };
}

export function moveStep(steps: EditorStep[], from: number, to: number): EditorStep[] {
  if (from === to || from < 0 || from >= steps.length || to < 0 || to >= steps.length) {
    return steps;
  }
  const next = [...steps];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Drag-and-drop: move `from` so that it lands at insertion slot `slot` (0..n). */
export function moveToSlot(steps: EditorStep[], from: number, slot: number): EditorStep[] {
  if (slot === from || slot === from + 1) return steps;
  return moveStep(steps, from, slot > from ? slot - 1 : slot);
}

export function removeStep(steps: EditorStep[], key: number): EditorStep[] {
  return steps
    .filter((step) => step.key !== key)
    .map((step) => {
      if (step.elseTarget !== key && step.thenTarget !== key) return step;
      return {
        ...step,
        elseMode: step.elseTarget === key ? "stop" : step.elseMode,
        elseTarget: step.elseTarget === key ? null : step.elseTarget,
        thenTarget: step.thenTarget === key ? null : step.thenTarget,
      };
    });
}

export function duplicateStep(
  steps: EditorStep[],
  key: number
): { steps: EditorStep[]; key: number } {
  const index = steps.findIndex((step) => step.key === key);
  if (index < 0) return { steps, key };
  const copy: EditorStep = {
    ...steps[index],
    key: nextKey(),
    conditions: steps[index].conditions.map((c) => ({ ...c })),
    args: { ...steps[index].args },
  };
  return { steps: [...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)], key: copy.key };
}

export function changeKind(step: EditorStep, kind: WorkflowStepKind): EditorStep {
  return { ...step, kind, thenTarget: kind === "branch" ? step.thenTarget : null };
}

// ---------------------------------------------------------------------------
// Validation (mirrors the Control Plane rules so problems show up on the
// canvas before Save - the server stays the authority)
// ---------------------------------------------------------------------------

export function stepIssues(
  step: EditorStep,
  steps: EditorStep[],
  catalog: WorkflowCatalog | null
): string[] {
  const issues: string[] = [];
  const maxWait = catalog?.limits.maxWaitMinutes ?? MAX_WAIT_MINUTES_DEFAULT;
  switch (step.kind) {
    case "condition":
    case "branch": {
      const live = step.conditions.filter((c) => c.field);
      if (!live.length) issues.push("Add at least one rule.");
      live.forEach((c, i) => {
        if (c.op !== "in_hours" && !c.value.trim()) issues.push("Rule " + (i + 1) + " needs a value.");
      });
      if (step.elseMode === "goto" && stepNo(steps, step.elseTarget) === null) {
        issues.push("The jump target was removed - pick another step.");
      }
      break;
    }
    case "ai_decision":
      if (!step.question.trim()) issues.push("Write the yes/no question.");
      else if (step.question.trim().length > 300) issues.push("Question is too long (max 300).");
      if (step.elseMode === "goto" && stepNo(steps, step.elseTarget) === null) {
        issues.push("The jump target was removed - pick another step.");
      }
      break;
    case "action": {
      if (!step.action) {
        issues.push("Pick an action.");
        break;
      }
      const spec = catalog?.actions.find((a) => a.action === step.action);
      if (catalog && !spec) issues.push("Unknown action.");
      const advanced = parseAdvancedArgs(step);
      if (advanced === null) issues.push("Advanced arguments must be a JSON object.");
      const missing = (spec?.required ?? []).filter(
        (arg) =>
          !AUTO_ARGS.includes(arg) &&
          !(step.args[arg] ?? "").trim() &&
          !(advanced && advanced[arg] !== undefined)
      );
      if (missing.length) issues.push("Missing: " + missing.join(", ") + ".");
      break;
    }
    case "wait": {
      const minutes = waitMinutes(step);
      if (minutes < 1 || minutes > maxWait) issues.push("Wait must be between 1 minute and 7 days.");
      break;
    }
    case "approval":
      if (!step.summary.trim()) issues.push("Describe what the owner is approving.");
      break;
    case "handoff":
      if (step.userId.trim() && !/^\d+$/.test(step.userId.trim())) issues.push("Teammate id must be a number.");
      break;
    case "goal":
      if (!step.goalName.trim()) issues.push("Name the goal.");
      break;
    default:
      break;
  }
  return issues;
}

export function allIssues(
  steps: EditorStep[],
  catalog: WorkflowCatalog | null
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const step of steps) {
    const issues = stepIssues(step, steps, catalog);
    if (issues.length) out.set(step.key, issues);
  }
  return out;
}

/** Which steps a run can actually reach from the trigger. */
export function reachability(steps: EditorStep[]): boolean[] {
  const seen = steps.map(() => false);
  const queue: number[] = steps.length ? [0] : [];
  const indexOfKey = (key: number | null): number =>
    key === null ? -1 : steps.findIndex((s) => s.key === key);
  while (queue.length) {
    const i = queue.shift() as number;
    if (i < 0 || i >= steps.length || seen[i]) continue;
    seen[i] = true;
    const step = steps[i];
    if (TERMINAL_KINDS.includes(step.kind)) continue;
    if (DECISION_KINDS.includes(step.kind)) {
      const yes = step.kind === "branch" && step.thenTarget !== null ? indexOfKey(step.thenTarget) : i + 1;
      queue.push(yes);
      if (step.elseMode === "skip") queue.push(i + 2);
      else if (step.elseMode === "continue") queue.push(i + 1);
      else if (step.elseMode === "goto") queue.push(indexOfKey(step.elseTarget));
    } else {
      queue.push(i + 1);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Summaries (one line under each node)
// ---------------------------------------------------------------------------

export function stepSummary(step: EditorStep, catalog: WorkflowCatalog | null): string {
  switch (step.kind) {
    case "condition":
    case "branch": {
      const live = step.conditions.filter((c) => c.field);
      if (!live.length) return "No rules yet";
      const first = live[0];
      const fieldLabel = CONDITION_FIELDS.find((f) => f.value === first.field)?.label ?? first.field;
      const opLabel = CONDITION_OPS.find((o) => o.value === first.op)?.label ?? first.op;
      const head = fieldLabel + " " + opLabel + (first.op === "in_hours" ? "" : " \u201c" + first.value + "\u201d");
      return live.length > 1 ? head + " +" + (live.length - 1) + " more (" + step.group + ")" : head;
    }
    case "ai_decision":
      return step.question.trim() || "No question yet";
    case "action": {
      const spec = catalog?.actions.find((a) => a.action === step.action);
      const text = step.args.body ?? step.args.tag ?? step.args.stage ?? step.args.content ?? "";
      return (spec?.description ?? step.action) + (text ? " \u00b7 " + text : "");
    }
    case "wait": {
      const minutes = waitMinutes(step);
      if (minutes >= 1440 && minutes % 1440 === 0) return (minutes / 1440) + (minutes === 1440 ? " day" : " days");
      if (minutes >= 60 && minutes % 60 === 0) return (minutes / 60) + (minutes === 60 ? " hour" : " hours");
      return minutes + (minutes === 1 ? " minute" : " minutes");
    }
    case "approval":
      return step.summary.trim() || "No summary yet";
    case "handoff":
      return step.userId.trim() ? "Teammate #" + step.userId.trim() : "First available teammate";
    case "goal":
      return step.goalName.trim() || "Unnamed goal";
    default:
      return "Run ends here";
  }
}

// ---------------------------------------------------------------------------
// Layout (pure geometry - the canvas only draws what this returns)
// ---------------------------------------------------------------------------

export const NODE_W = 272;
export const NODE_H = 68;
export const GAP_Y = 52;
export const PAD_X = 56;
export const PAD_Y = 24;
export const RAIL_R = 88;
export const STOP_W = 60;
export const STOP_H = 24;

export interface LayoutNode {
  id: string; // "trigger" | "step-<key>"
  key: number | null;
  index: number; // 0 = trigger, steps at index + 1
  x: number;
  y: number;
}

export interface LayoutEdge {
  id: string;
  kind: "next" | "yes" | "no" | "skip" | "jump";
  path: string;
  label: string;
  labelX: number;
  labelY: number;
  /** drawn dashed: the flow cannot normally continue this way */
  dashed: boolean;
}

export interface LayoutStop {
  id: string;
  x: number;
  y: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  stops: LayoutStop[];
}

export function nodeY(index: number): number {
  return PAD_Y + index * (NODE_H + GAP_Y);
}

/** Insertion slot (0..count) for a pointer at canvas y. */
export function slotFromY(y: number, count: number): number {
  let slot = 0;
  for (let i = 0; i < count; i++) {
    if (y > nodeY(i + 1) + NODE_H / 2) slot = i + 1;
  }
  return Math.max(0, Math.min(count, slot));
}

/** y of the drop indicator for insertion slot k. */
export function slotIndicatorY(slot: number): number {
  return nodeY(slot) + NODE_H + GAP_Y / 2;
}

function vertical(x: number, y1: number, y2: number): string {
  return "M " + x + " " + y1 + " L " + x + " " + y2;
}

function rightCurve(x1: number, y1: number, x2: number, y2: number): string {
  const rail = Math.max(x1, x2) + 56;
  return "M " + x1 + " " + y1 + " C " + rail + " " + y1 + " " + rail + " " + y2 + " " + x2 + " " + y2;
}

function leftCurve(x1: number, y1: number, x2: number, y2: number): string {
  const rail = Math.min(x1, x2) - 40;
  return "M " + x1 + " " + y1 + " C " + rail + " " + y1 + " " + rail + " " + y2 + " " + x2 + " " + y2;
}

export function layoutWorkflow(steps: EditorStep[]): Layout {
  const nodes: LayoutNode[] = [{ id: "trigger", key: null, index: 0, x: PAD_X, y: nodeY(0) }];
  steps.forEach((step, i) => {
    nodes.push({ id: "step-" + step.key, key: step.key, index: i + 1, x: PAD_X, y: nodeY(i + 1) });
  });
  const edges: LayoutEdge[] = [];
  const stops: LayoutStop[] = [];
  const cx = PAD_X + NODE_W / 2;
  const xr = PAD_X + NODE_W;
  const indexOfKey = (key: number | null): number =>
    key === null ? -1 : steps.findIndex((s) => s.key === key);
  const mid = (i: number): number => nodeY(i + 1) + NODE_H / 2;

  // trigger -> first step
  if (steps.length) {
    edges.push({
      id: "e-trigger",
      kind: "next",
      path: vertical(cx, nodeY(0) + NODE_H, nodeY(1)),
      label: "",
      labelX: cx,
      labelY: 0,
      dashed: false,
    });
  }

  steps.forEach((step, i) => {
    const hasNext = i + 1 < steps.length;
    const isDecision = DECISION_KINDS.includes(step.kind);
    const terminal = TERMINAL_KINDS.includes(step.kind);
    const yesJump = step.kind === "branch" && step.thenTarget !== null ? indexOfKey(step.thenTarget) : -1;

    // main / yes exit
    if (yesJump >= 0 && yesJump !== i) {
      edges.push({
        id: "e-yes-" + step.key,
        kind: "yes",
        path: leftCurve(PAD_X, mid(i), PAD_X, mid(yesJump)),
        label: "yes \u2192 " + (yesJump + 1),
        labelX: PAD_X - 8,
        labelY: mid(i) - 6,
        dashed: false,
      });
      if (hasNext) {
        edges.push({
          id: "e-next-" + step.key,
          kind: "next",
          path: vertical(cx, nodeY(i + 1) + NODE_H, nodeY(i + 2)),
          label: "",
          labelX: cx,
          labelY: 0,
          dashed: true,
        });
      }
    } else if (hasNext) {
      edges.push({
        id: "e-next-" + step.key,
        kind: isDecision ? "yes" : "next",
        path: vertical(cx, nodeY(i + 1) + NODE_H, nodeY(i + 2)),
        label: isDecision ? "yes" : "",
        // sits just right of the "+" insert button that the canvas draws on the connector
        labelX: cx + 16,
        labelY: nodeY(i + 1) + NODE_H + GAP_Y / 2 + 4,
        dashed: terminal,
      });
    }

    // no exit
    if (!isDecision) return;
    if (step.elseMode === "stop") {
      const stop = { id: "stop-" + step.key, x: xr + RAIL_R - STOP_W / 2, y: mid(i) - STOP_H / 2 };
      stops.push(stop);
      edges.push({
        id: "e-no-" + step.key,
        kind: "no",
        path: "M " + xr + " " + mid(i) + " L " + stop.x + " " + mid(i),
        label: "no",
        labelX: xr + 10,
        labelY: mid(i) - 6,
        dashed: false,
      });
      return;
    }
    if (step.elseMode === "continue") return;
    const target = step.elseMode === "skip" ? i + 2 : indexOfKey(step.elseTarget);
    if (target < 0 || target === i) return;
    if (target >= steps.length) {
      const stop = { id: "stop-" + step.key, x: xr + RAIL_R - STOP_W / 2, y: mid(i) - STOP_H / 2 };
      stops.push(stop);
      edges.push({
        id: "e-no-" + step.key,
        kind: "no",
        path: "M " + xr + " " + mid(i) + " L " + stop.x + " " + mid(i),
        label: step.elseMode === "skip" ? "no (skip) \u2192 end" : "no",
        labelX: xr + 10,
        labelY: mid(i) - 6,
        dashed: false,
      });
      return;
    }
    edges.push({
      id: "e-no-" + step.key,
      kind: step.elseMode === "skip" ? "skip" : "jump",
      path: rightCurve(xr, mid(i), xr, mid(target)),
      label: (step.elseMode === "skip" ? "no (skip) \u2192 " : "no \u2192 ") + (target + 1),
      labelX: xr + 10,
      labelY: mid(i) - 6,
      dashed: false,
    });
  });

  const rows = steps.length + 1;
  return {
    width: PAD_X + NODE_W + RAIL_R + STOP_W,
    // one spare row below the last node: the trailing "+" slot / drop zone
    height: PAD_Y * 2 + (rows + 1) * NODE_H + rows * GAP_Y,
    nodes,
    edges,
    stops,
  };
}
