import type { WorkflowGenInput } from "./portal";
import { parseWorkflowPayload } from "./workflow-payload";

/** Same limits as the Control Plane (portal_workflow_gen). */
export const WORKFLOW_GEN_MAX_DESCRIPTION = 1000;
export const WORKFLOW_GEN_MAX_INSTRUCTION = 500;

/**
 * Shape check for "describe a workflow" / "change it with AI". Only known
 * fields pass; the Control Plane owns the deep validation. ``current`` (the
 * builder's workflow, snake_case like the save payload) is optional.
 */
export function workflowGenInput(
  body: Record<string, unknown>
): { ok: true; input: WorkflowGenInput } | { ok: false; message: string } {
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (description.length > WORKFLOW_GEN_MAX_DESCRIPTION) {
    return {
      ok: false,
      message: "Keep the description under " + WORKFLOW_GEN_MAX_DESCRIPTION + " characters.",
    };
  }
  if (instruction.length > WORKFLOW_GEN_MAX_INSTRUCTION) {
    return {
      ok: false,
      message: "Keep the change request under " + WORKFLOW_GEN_MAX_INSTRUCTION + " characters.",
    };
  }
  let current: WorkflowGenInput["current"] = null;
  if (body.current !== undefined && body.current !== null) {
    const parsed = parseWorkflowPayload(body.current);
    if (!parsed.ok) {
      return { ok: false, message: "The workflow in the builder is not valid yet: " + parsed.message };
    }
    current = parsed.input;
  }
  if (!current && !description) return { ok: false, message: "Describe the workflow you want." };
  if (current && !instruction) return { ok: false, message: "Say what should change." };
  return { ok: true, input: { description, instruction, current } };
}
