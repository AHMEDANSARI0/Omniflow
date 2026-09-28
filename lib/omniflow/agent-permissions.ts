import type { AgentRisk } from "./portal";

/**
 * Agent permission envelope shared by the agents BFF routes (create +
 * update): registry action names the persona may trigger (null = every
 * action), the highest action risk it may trigger, and whether the brain
 * may auto-send under it. Validation of action NAMES happens on the
 * Control Plane against the live action registry.
 */
export interface AgentPermissionFields {
  allowedActions: string[] | null;
  maxRisk: AgentRisk;
  canAutoReply: boolean;
}

export const AGENT_RISK_LEVELS: readonly AgentRisk[] = ["low", "medium", "high"];

const MAX_ALLOWED_ACTIONS = 100;
const MAX_ACTION_NAME = 60;

export type AgentPermissionParse =
  | { ok: true; value: AgentPermissionFields }
  | { ok: false; message: string };

export function parseAgentPermissions(
  payload: Record<string, unknown> | null
): AgentPermissionParse {
  const rawAllowed = payload?.allowed_actions;
  let allowedActions: string[] | null = null;
  if (rawAllowed !== undefined && rawAllowed !== null) {
    if (!Array.isArray(rawAllowed)) {
      return {
        ok: false,
        message: "allowed_actions must be a list of action names or null.",
      };
    }
    const names: string[] = [];
    for (const item of rawAllowed) {
      if (typeof item !== "string") {
        return {
          ok: false,
          message: "allowed_actions must contain action names only.",
        };
      }
      const name = item.trim();
      if (!name || name.length > MAX_ACTION_NAME) {
        return { ok: false, message: "allowed_actions contains a bad name." };
      }
      if (!names.includes(name)) names.push(name);
    }
    allowedActions = names.slice(0, MAX_ALLOWED_ACTIONS);
  }
  const rawRisk = payload?.max_risk;
  let maxRisk: AgentRisk = "high";
  if (rawRisk !== undefined && rawRisk !== null) {
    if (
      typeof rawRisk !== "string" ||
      !AGENT_RISK_LEVELS.includes(rawRisk as AgentRisk)
    ) {
      return { ok: false, message: "max_risk must be low, medium or high." };
    }
    maxRisk = rawRisk as AgentRisk;
  }
  const rawAuto = payload?.can_auto_reply;
  let canAutoReply = true;
  if (rawAuto !== undefined && rawAuto !== null) {
    if (typeof rawAuto !== "boolean") {
      return { ok: false, message: "can_auto_reply must be true or false." };
    }
    canAutoReply = rawAuto;
  }
  return { ok: true, value: { allowedActions, maxRisk, canAutoReply } };
}
