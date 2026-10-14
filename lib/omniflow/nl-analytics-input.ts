import type { NlPlan } from "./portal";

/** Max question length (the Control Plane enforces the same limit). */
export const NL_MAX_QUESTION = 300;

/**
 * Browser plan -> NlPlan, or null when it is not a plan. Only the shape is
 * checked here; the Control Plane validates every key against its catalog.
 */
export function nlPlanFromBody(value: unknown): NlPlan | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.metric !== "string" || !row.metric) return null;
  const filters: Record<string, string> = {};
  const raw = row.filters;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof item === "string") filters[key] = item;
    }
  }
  return {
    metric: row.metric,
    period: typeof row.period === "string" ? row.period : "last_30_days",
    compare: row.compare === "previous" ? "previous" : "none",
    groupBy: typeof row.groupBy === "string" ? row.groupBy : "none",
    filters,
    limit: typeof row.limit === "number" ? row.limit : 10,
  };
}
