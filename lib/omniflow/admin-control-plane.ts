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
  init: RequestInit,
  options: { timeoutMs?: number; passStatuses?: number[] } = {}
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
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_unavailable");
  }

  if (!response.ok && !(options.passStatuses ?? []).includes(response.status)) {
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
  | "ai"
  | "stt"
  | "embeddings"
  | "vision"
  | "assistant"
  | "router";

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
): Promise<AdminProviderSaveResult | { invalid: string }> {
  const response = await adminRequest(
    "api/v1/admin/providers",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group, values }),
    },
    { passStatuses: [400] }
  );
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 400) {
    // the Control Plane's own sentence ("router.fast_model must be ...")
    const error =
      payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
    const message =
      error && typeof error === "object" ? (error as { message?: unknown }).message : null;
    return {
      invalid:
        typeof message === "string" && message
          ? message.slice(0, 300)
          : "The Control Plane rejected one of the values.",
    };
  }
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

export type AdminGuardMode = "off" | "standard" | "strict";

export interface AdminAiControls {
  kill_switch: boolean;
  autonomy_cap: AdminAutonomy;
  daily_call_cap: number;
  guard_mode?: AdminGuardMode;
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
  blocked?: number;
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
  blocked?: number;
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

export interface AdminAiEvalCase {
  id: string;
  category: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface AdminAiEval {
  suite: string;
  version: string;
  mode: "deterministic_contracts" | string;
  llm_calls: number;
  customer_data: boolean;
  passed: number;
  total: number;
  score: number;
  status: "pass" | "fail" | string;
  failed: string[];
  cases: AdminAiEvalCase[];
}

export async function getAdminAiEval(): Promise<AdminAiEval> {
  const response = await adminRequest("api/v1/admin/ai/eval", {
    method: "GET",
  });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("cases" in payload) ||
    !Array.isArray((payload as { cases: unknown }).cases)
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminAiEval;
}

export type AdminAiQuality = Record<string, unknown>;

export async function getAdminAiQuality(
  days = 7,
  clientId?: number
): Promise<AdminAiQuality> {
  const safeDays = [1, 7, 14, 30].includes(days) ? days : 7;
  let path = "api/v1/admin/ai/quality?days=" + safeDays;
  if (typeof clientId === "number" && clientId > 0) {
    path += "&client_id=" + encodeURIComponent(String(clientId));
  }
  const response = await adminRequest(path, { method: "GET" });
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== "object") {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminAiQuality;
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

// ---------------------------------------------------------------------------
// D5 (§212): phone numbers -> workspaces (the dialled number decides which
// workspace's assistant answers). 400/409 carry owner-readable messages, so
// these calls do not use adminRequest (which throws on every non-2xx).
// ---------------------------------------------------------------------------

export interface AdminVoiceNumber {
  client_id: number;
  number: string;
  enabled: boolean;
}

export type AdminVoiceNumberResult =
  | { kind: "ok"; clientId: number; number: string }
  | { kind: "invalid"; status: number; message: string }
  | { kind: "unavailable" };

async function adminVoiceFetch(
  init: RequestInit,
  path = "api/v1/admin/voice/numbers"
): Promise<Response> {
  const url = new URL(path, controlPlaneBaseUrl());
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Omniflow-Key", serviceKey());
  try {
    return await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_unavailable");
  }
}

export async function listAdminVoiceNumbers(): Promise<AdminVoiceNumber[] | null> {
  const response = await adminVoiceFetch({ method: "GET" });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    numbers?: AdminVoiceNumber[];
  } | null;
  return payload && Array.isArray(payload.numbers) ? payload.numbers : null;
}

export async function assignAdminVoiceNumber(
  clientId: number,
  number: string
): Promise<AdminVoiceNumberResult> {
  const response = await adminVoiceFetch({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, number }),
  });
  const payload = (await response.json().catch(() => null)) as {
    client_id?: number;
    number?: string;
    error?: { message?: string };
  } | null;
  if (response.ok && payload) {
    return {
      kind: "ok",
      clientId: Number(payload.client_id || clientId),
      number: String(payload.number || ""),
    };
  }
  if (response.status === 400 || response.status === 409) {
    return {
      kind: "invalid",
      status: response.status,
      message: payload?.error?.message || "That number could not be assigned.",
    };
  }
  return { kind: "unavailable" };
}

// ---------------------------------------------------------------------------
// §214: Twilio number setup from the panel. The Control Plane reads the
// account's numbers and points one number's Voice URL + status callback at
// itself when the admin confirms. Numbers on a TwiML app / SIP trunk are
// refused (Twilio ignores webhook URLs while either is attached).
// ---------------------------------------------------------------------------

export interface AdminTwilioNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  /** connected | partial | elsewhere | app | trunk | not_set */
  state: string;
  voice_host: string;
  voice_capable: boolean;
  assigned_client_id: number | null;
}

export interface AdminTwilioNumbersPayload {
  base_url: string;
  /** env | panel | request | none */
  base_source: string;
  voice_url: string;
  status_url: string;
  numbers: AdminTwilioNumber[];
  truncated: boolean;
}

export type AdminTwilioResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "invalid"; status: number; message: string }
  | { kind: "unavailable" };

async function adminTwilioResult<T>(response: Response): Promise<AdminTwilioResult<T>> {
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (response.ok && payload) return { kind: "ok", data: payload };
  if ([400, 404, 409, 502].includes(response.status)) {
    return {
      kind: "invalid",
      status: response.status,
      message: payload?.error?.message || "Twilio could not complete that request.",
    };
  }
  return { kind: "unavailable" };
}

export async function listAdminTwilioNumbers(): Promise<
  AdminTwilioResult<AdminTwilioNumbersPayload>
> {
  const response = await adminVoiceFetch({ method: "GET" }, "api/v1/admin/voice/twilio");
  return adminTwilioResult<AdminTwilioNumbersPayload>(response);
}

export async function connectAdminTwilioNumber(
  sid: string
): Promise<AdminTwilioResult<{ ok: boolean; number: AdminTwilioNumber; base_url: string }>> {
  const response = await adminVoiceFetch(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid }),
    },
    "api/v1/admin/voice/twilio/connect"
  );
  return adminTwilioResult(response);
}

// §223 Secrets vault (stored provider credentials encrypted at rest).
export interface AdminVaultArea {
  label: string;
  table: string;
  present: boolean;
  plain: number;
  sealed: number;
  old_key: number;
  unreadable: number;
  resealed: number;
  error: string;
}

export interface AdminVaultReport {
  status: {
    library: boolean;
    configured: boolean;
    key_id: string;
    old_key_ids: string[];
    problem: "" | "key_missing" | "key_too_short" | "library_missing";
    min_key_chars: number;
    algorithm: string;
  };
  areas: AdminVaultArea[];
  totals: { plain: number; sealed: number; old_key: number; unreadable: number; resealed: number };
  migrated: boolean;
  remaining: number;
}

function vaultReport(payload: unknown): AdminVaultReport {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("status" in payload) ||
    !("areas" in payload) ||
    !Array.isArray((payload as { areas: unknown }).areas)
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminVaultReport;
}

export async function getAdminVault(): Promise<AdminVaultReport> {
  const response = await adminRequest("api/v1/admin/security/vault", { method: "GET" });
  return vaultReport(await response.json());
}

export async function migrateAdminVault(): Promise<AdminVaultReport> {
  const response = await adminRequest("api/v1/admin/security/vault/migrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return vaultReport(await response.json());
}

// ---------------------------------------------------------------------------
// Model Router (§229): which model answers which AI task, with failover.
// Settings save through putAdminProviders("router", ...).
// ---------------------------------------------------------------------------

export type RouterTier = "fast" | "smart" | "main";
export type RouterProvider = "primary" | "secondary";
export type RouterTestTarget = "primary" | "secondary" | "fast" | "smart";

export interface AdminRouterRoute {
  feature: string;
  label: string;
  tier: RouterTier;
  default_tier: RouterTier;
  provider: RouterProvider;
  model: string;
  calls: number;
  failed: number;
  failovers: number;
  tokens: number;
  cost_usd: number | null;
}

export interface AdminRouterDedicated {
  feature: string;
  label: string;
  model: string;
  key_source: string;
  active: boolean;
  reason: string;
  failover: boolean;
}

export interface AdminRouterModelUsage {
  model: string;
  calls: number;
  failed: number;
  tokens: number;
  avg_latency_ms: number;
  cost_usd: number | null;
}

export interface AdminModelRouter {
  mode: "on" | "off";
  failover: "on" | "off";
  settings: {
    mode: string;
    failover: string;
    fast_provider: string;
    fast_model: string;
    smart_provider: string;
    smart_model: string;
    routes: Record<string, RouterTier>;
    secondary_base_url: string;
    secondary_api_key: string;
    secondary_model: string;
    breaker_failures: string;
    breaker_seconds: string;
  };
  primary: { configured: boolean; enabled: boolean; base_url: string; model: string };
  secondary: { configured: boolean; base_url: string; model: string; from_env: boolean };
  tiers: Record<RouterTier, { provider: RouterProvider; model: string }>;
  routes: AdminRouterRoute[];
  dedicated: AdminRouterDedicated[];
  breaker: {
    failures: number;
    seconds: number;
    state: Record<RouterProvider, { failures: number; paused: boolean; paused_seconds_left: number }>;
  };
  usage: {
    days: number;
    calls: number;
    failed: number;
    failovers: number;
    routed: number;
    tokens: number;
    cost_usd: number | null;
    models: AdminRouterModelUsage[];
    error: string | null;
  };
  prices_configured: boolean;
  warnings: string[];
}

export async function getAdminModelRouter(days: number): Promise<AdminModelRouter> {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(90, Math.round(days))) : 7;
  const response = await adminRequest("api/v1/admin/ai/router?days=" + safeDays, {
    method: "GET",
  });
  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { routes?: unknown }).routes) ||
    typeof (payload as { settings?: unknown }).settings !== "object"
  ) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminModelRouter;
}

export interface AdminRouterTestResult {
  ok: boolean;
  target: RouterTestTarget;
  provider: RouterProvider;
  model: string;
  latency_ms: number;
  error: string;
}

export async function testAdminModelRouter(
  target: RouterTestTarget
): Promise<AdminRouterTestResult | { invalid: string }> {
  const response = await adminRequest(
    "api/v1/admin/ai/router/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    },
    { timeoutMs: 20_000, passStatuses: [400, 409] }
  );
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 400 || response.status === 409) {
    const error =
      payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
    const message =
      error && typeof error === "object" ? (error as { message?: unknown }).message : null;
    return { invalid: typeof message === "string" && message ? message : "Not configured." };
  }
  if (payload === null || typeof payload !== "object" || !("ok" in payload)) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return payload as AdminRouterTestResult;
}
