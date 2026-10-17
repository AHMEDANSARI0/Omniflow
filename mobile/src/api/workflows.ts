/**
 * §278 P3 workflows view + toggle. Backed by the existing CP portal
 * endpoints (portal_workflows.py): GET /workflows lists with run stats,
 * POST /workflows/<id>/status flips active <-> paused (the CP enforces
 * tenant isolation and refuses to activate step-less workflows).
 */

import { z } from "zod";
import { api } from "@/api/client";

const n0 = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0))
  .catch(0);

const str = (fallback = "") =>
  z
    .string()
    .nullish()
    .transform((v) => (typeof v === "string" ? v : fallback))
    .catch(fallback);

export const workflowRunsSchema = z.object({
  total: n0,
  live: n0,
  goals: n0,
  failed: n0,
  last_run_at: str(),
});
export type WorkflowRuns = z.infer<typeof workflowRunsSchema>;

export const workflowSchema = z.object({
  id: n0,
  name: str("Workflow"),
  description: str(),
  status: z.enum(["draft", "active", "paused", "archived"]).catch("draft"),
  trigger_type: str("manual"),
  stop_on_reply: z.boolean().catch(false),
  version: n0,
  updated_at: str(),
  steps: n0,
  runs: workflowRunsSchema.catch({
    total: 0,
    live: 0,
    goals: 0,
    failed: 0,
    last_run_at: "",
  }),
});
export type Workflow = z.infer<typeof workflowSchema>;

export const workflowListSchema = z.object({
  workflows: z.array(workflowSchema).catch([]),
});
export type WorkflowList = z.infer<typeof workflowListSchema>;

export async function listWorkflows(): Promise<WorkflowList> {
  const data = await api.get<unknown>("/api/v1/portal/workflows");
  return workflowListSchema.parse(data ?? {});
}

export const workflowStatusSchema = z.object({
  ok: z.boolean().catch(false),
  status: str(),
});

export async function setWorkflowStatus(
  id: number,
  status: "active" | "paused",
): Promise<string> {
  const data = await api.post<unknown>(
    `/api/v1/portal/workflows/${id}/status`,
    { status },
  );
  const parsed = workflowStatusSchema.parse(data ?? {});
  if (!parsed.ok) throw new Error("Workflow status update was rejected.");
  return parsed.status || status;
}
