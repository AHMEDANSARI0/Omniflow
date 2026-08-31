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
