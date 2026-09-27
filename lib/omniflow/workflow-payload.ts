import type { WorkflowUpsert } from "./portal";

const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_STEPS = 12;
const STEP_KINDS = new Set([
  "condition",
  "branch",
  "ai_decision",
  "action",
  "wait",
  "approval",
  "handoff",
  "goal",
  "stop",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Shape check only - the Control Plane owns the deep validation. */
export function parseWorkflowPayload(
  payload: unknown
): { ok: true; input: WorkflowUpsert } | { ok: false; message: string } {
  if (!isRecord(payload)) return { ok: false, message: "Invalid body." };
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name || name.length > MAX_NAME) {
    return { ok: false, message: "name (max " + MAX_NAME + " chars) is required." };
  }
  const description =
    typeof payload.description === "string" ? payload.description.trim() : "";
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, message: "description is too long." };
  }
  const triggerType =
    typeof payload.trigger_type === "string" ? payload.trigger_type.trim() : "";
  if (!triggerType) return { ok: false, message: "trigger_type is required." };
  const triggerConfig = isRecord(payload.trigger_config)
    ? payload.trigger_config
    : {};
  const rawSteps = Array.isArray(payload.steps) ? payload.steps : null;
  if (rawSteps === null) return { ok: false, message: "steps must be a list." };
  if (rawSteps.length > MAX_STEPS) {
    return { ok: false, message: "max " + MAX_STEPS + " steps." };
  }
  const steps: WorkflowUpsert["steps"] = [];
  for (const raw of rawSteps) {
    if (!isRecord(raw) || typeof raw.kind !== "string" || !STEP_KINDS.has(raw.kind)) {
      return { ok: false, message: "each step needs a valid kind." };
    }
    steps.push({
      kind: raw.kind,
      label: typeof raw.label === "string" ? raw.label.slice(0, 60) : "",
      config: isRecord(raw.config) ? raw.config : {},
    });
  }
  return {
    ok: true,
    input: {
      name,
      description,
      triggerType,
      triggerConfig,
      stopOnReply: payload.stop_on_reply === true,
      steps,
    },
  };
}
