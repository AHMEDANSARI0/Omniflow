import "server-only";

import { ControlPlaneRequestError } from "./control-plane";


const REQUEST_TIMEOUT_MS = 8_000;

function serviceKey(): string {
  const key = process.env.OMNIFLOW_SERVICE_KEY?.trim();
  if (!key) {
    throw new ControlPlaneRequestError(503, "service_not_configured");
  }
  return key;
}

function controlPlaneBaseUrl(): URL {
  const raw = process.env.OMNIFLOW_CONTROL_PLANE_URL?.trim();
  if (!raw) {
    throw new ControlPlaneRequestError(503, "control_plane_not_configured");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ControlPlaneRequestError(503, "control_plane_url_invalid");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new ControlPlaneRequestError(503, "control_plane_tls_required");
  }

  url.pathname = url.pathname.replace(/\/$/, "") + "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function adminRequest(
  path: string,
  init: RequestInit
): Promise<Response> {
  const url = new URL(path.replace(/^\//, ""), controlPlaneBaseUrl());
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Omniflow-Key", serviceKey());

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_unavailable");
  }

  if (!response.ok) {
    throw new ControlPlaneRequestError(response.status, "admin_request_failed");
  }
  return response;
}

export type AdminProviderGroup =
  | "email"
  | "llm"
  | "flags"
  | "voice"
  | "video"
  | "payments"
  | "whatsapp_e2e"
  | "ai";

export interface AdminProviderGroups {
  [group: string]: {
    [key: string]: string | boolean;
  } & { configured: boolean };
}

export interface AdminProvidersPayload {
  groups: AdminProviderGroups;
}

export interface AdminProviderSaveResult {
  ok: boolean;
  kept_blank: string[];
  configured: boolean;
}

export async function getAdminProviders(): Promise<AdminProvidersPayload> {
  const response = await adminRequest("api/v1/admin/providers", {
    method: "GET",
  });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("groups" in payload) ||
    typeof (payload as { groups: unknown }).groups !== "object"
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminProvidersPayload;
}

export async function putAdminProviders(
  group: AdminProviderGroup,
  values: Record<string, string>
): Promise<AdminProviderSaveResult> {
  const response = await adminRequest("api/v1/admin/providers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group, values }),
  });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("ok" in payload)
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminProviderSaveResult;
}

export interface AdminEmailActionResult {
  ok: boolean;
  detail: string;
  clients?: number;
}

export async function sendAdminTestEmail(
  to: string
): Promise<AdminEmailActionResult> {
  const response = await adminRequest("api/v1/admin/email/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    typeof (payload as { ok: unknown }).ok !== "boolean"
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminEmailActionResult;
}

export async function sendAdminWeeklyReport(
  to: string
): Promise<AdminEmailActionResult> {
  const response = await adminRequest("api/v1/admin/weekly-report/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    typeof (payload as { ok: unknown }).ok !== "boolean"
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminEmailActionResult;
}

export interface AdminClientUser {
  id: number;
  email: string;
  display_name: string | null;
  status: string | null;
  last_login_at: string | null;
  failed_attempt_count: number;
  locked: boolean;
}

export async function listAdminUsers(): Promise<AdminClientUser[]> {
  const response = await adminRequest("api/v1/admin/users", { method: "GET" });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("users" in payload) ||
    !Array.isArray((payload as { users: unknown }).users)
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return (payload as { users: AdminClientUser[] }).users;
}

export interface AdminPasswordReset {
  user_id: number;
  email: string;
  temp_password: string;
}

export async function resetAdminPassword(
  userId: number
): Promise<AdminPasswordReset> {
  const response = await adminRequest(
    `api/v1/admin/users/${userId}/password-reset`,
    { method: "POST" }
  );
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("temp_password" in payload) ||
    typeof (payload as { temp_password: unknown }).temp_password !== "string"
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminPasswordReset;
}

export interface AdminResetCode {
  user_id: number;
  email: string;
  code: string;
  expires_at: string;
  created_at: string;
}

/** TEST-PHASE: recent undelivered reset codes (populated only without SMTP). */
export async function listRecentResetCodes(): Promise<AdminResetCode[]> {
  const response = await adminRequest("api/v1/admin/reset-codes", {
    method: "GET",
  });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("codes" in payload) ||
    !Array.isArray((payload as { codes: unknown }).codes)
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return (payload as { codes: AdminResetCode[] }).codes;
}

// ---------------------------------------------------------------------------
// AI Control Center (platform-wide AI posture + controls)
// ---------------------------------------------------------------------------

export type AdminAutonomy = "off" | "suggest" | "auto";

export interface AdminAiControls {
  kill_switch: boolean;
  autonomy_cap: AdminAutonomy;
  daily_call_cap: number;
  source: "panel" | "env" | "default";
}

export interface AdminAiWorkspace {
  client_id: number;
  name: string;
  owner: string;
  email: string;
  users: number;
  autonomy: AdminAutonomy;
  autonomy_updated_at: string | null;
  agents_active: number;
  agents_total: number;
  agents_draft_only: number;
  calls: number;
  failed: number;
  tokens: number;
  cost_usd: number | null;
  last_call_at: string | null;
  open_escalations: number;
  pending_approvals: number;
  answers: number;
  handoffs: number;
}

export interface AdminAiTotals {
  workspaces: number;
  auto: number;
  suggest: number;
  off: number;
  agents_active: number;
  calls: number;
  failed: number;
  tokens: number;
  cost_usd: number;
  priced: boolean;
  open_escalations: number;
  pending_approvals: number;
  answers: number;
  handoffs: number;
}

export interface AdminAiRecent {
  id: number;
  client_id: number;
  action: string;
  category: string;
  actor_kind: string;
  conversation_id: number | null;
  note: string;
  created_at: string | null;
}

export interface AdminAiOverview {
  days: number;
  generated_at: string;
  controls: AdminAiControls;
  totals: AdminAiTotals;
  workspaces: AdminAiWorkspace[];
  recent: AdminAiRecent[];
}

export async function getAdminAiOverview(
  days: number
): Promise<AdminAiOverview> {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(90, days)) : 7;
  const response = await adminRequest(
    "api/v1/admin/ai/overview?days=" + safeDays,
    { method: "GET" }
  );
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("workspaces" in payload) ||
    !("controls" in payload)
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminAiOverview;
}

export interface AdminAutonomyResult {
  ok: boolean;
  client_id: number;
  autonomy: AdminAutonomy;
}

export async function setAdminClientAutonomy(
  clientId: number,
  autonomy: AdminAutonomy,
  reason: string
): Promise<AdminAutonomyResult> {
  const response = await adminRequest(
    "api/v1/admin/ai/clients/" + clientId + "/autonomy",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomy, reason }),
    }
  );
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("ok" in payload)
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminAutonomyResult;
}
