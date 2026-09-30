import type { AgentRisk, AgentSchedule } from "./portal";

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
  /** Present only when the client sent a schedule object. */
  schedule?: AgentSchedule;
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
  const value: AgentPermissionFields = {
    allowedActions,
    maxRisk,
    canAutoReply,
  };
  if (payload && "schedule" in payload) {
    const scheduleResult = parseAgentSchedule(payload.schedule);
    if (!scheduleResult.ok) return scheduleResult;
    value.schedule = scheduleResult.value;
  }
  return { ok: true, value };
}

function defaultSchedule(): AgentSchedule {
  return {
    enabled: false,
    timezone: "Asia/Karachi",
    days: Array.from({ length: 7 }, () => ({
      enabled: true,
      start: "09:00",
      end: "17:00",
    })),
  };
}

function parseHHMM(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length !== 5 || text[2] !== ":") return null;
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(3));
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return (
    String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0")
  );
}

export type AgentScheduleParse =
  | { ok: true; value: AgentSchedule }
  | { ok: false; message: string };

export function parseAgentSchedule(raw: unknown): AgentScheduleParse {
  if (raw === undefined || raw === null) {
    return { ok: true, value: defaultSchedule() };
  }
  if (typeof raw !== "object") {
    return { ok: false, message: "schedule must be an object." };
  }
  const row = raw as Record<string, unknown>;
  if ("enabled" in row && typeof row.enabled !== "boolean") {
    return { ok: false, message: "schedule.enabled must be true or false." };
  }
  let timezone = "Asia/Karachi";
  if ("timezone" in row) {
    if (typeof row.timezone !== "string" || !row.timezone.trim()) {
      return { ok: false, message: "schedule.timezone is required." };
    }
    timezone = row.timezone.trim().slice(0, 64);
  }
  const fallbackDays = defaultSchedule().days;
  let days = fallbackDays;
  if ("days" in row) {
    if (!Array.isArray(row.days) || row.days.length !== 7) {
      return {
        ok: false,
        message: "schedule.days must be a list of 7 day windows (Sun-Sat).",
      };
    }
    const built = [];
    for (let i = 0; i < 7; i++) {
      const item = row.days[i];
      if (!item || typeof item !== "object") {
        return {
          ok: false,
          message: "schedule.days[" + i + "] must be an object.",
        };
      }
      const d = item as Record<string, unknown>;
      if ("enabled" in d && typeof d.enabled !== "boolean") {
        return {
          ok: false,
          message: "schedule.days[" + i + "].enabled must be true or false.",
        };
      }
      const start =
        "start" in d ? parseHHMM(d.start) : fallbackDays[i].start;
      const end = "end" in d ? parseHHMM(d.end) : fallbackDays[i].end;
      if (!start || !end) {
        return {
          ok: false,
          message: "schedule.days[" + i + "] times must be HH:MM.",
        };
      }
      if (start >= end) {
        return {
          ok: false,
          message:
            "schedule.days[" + i + "] start must be before end (same-day only).",
        };
      }
      built.push({
        enabled: d.enabled !== false,
        start,
        end,
      });
    }
    days = built;
  }
  return {
    ok: true,
    value: {
      enabled: row.enabled === true,
      timezone,
      days,
    },
  };
}
