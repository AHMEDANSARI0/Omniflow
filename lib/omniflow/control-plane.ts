import "server-only";

import { randomUUID } from "crypto";


const REQUEST_TIMEOUT_MS = 8_000;
const ROLES = new Set(["owner", "admin", "agent", "analyst", "viewer"]);

export interface OmniFlowPrincipal {
  sessionId: string;
  userId: number;
  clientId: number;
  role: string;
  email: string;
  displayName: string | null;
  accessExpiresAt: string;
}

export interface OmniFlowSessionTokens {
  sessionId: string;
  userId: number;
  clientId: number;
  role: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface LoginInput {
  email: string;
  password: string;
  clientId?: number;
}

export class ControlPlaneRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super("OmniFlow Control Plane request failed");
    this.name = "ControlPlaneRequestError";
    this.status = status;
    this.code = code;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
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

  if (!['http:', 'https:'].includes(url.protocol)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maximum = 4096
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maximum = 4096
): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return value;
}

function positiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return Number(value);
}

function isoTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 100);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return value;
}

function role(record: Record<string, unknown>): string {
  const value = requiredString(record, "role", 30);
  if (!ROLES.has(value)) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return value;
}

function token(
  record: Record<string, unknown>,
  key: string,
  prefix: "ofa_" | "ofr_"
): string {
  const value = requiredString(record, key, 4096);
  if (!value.startsWith(prefix)) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
  return value;
}

function parseTokens(value: unknown): OmniFlowSessionTokens {
  if (!isRecord(value)) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }

  return {
    sessionId: requiredString(value, "session_id", 100),
    userId: positiveInteger(value, "user_id"),
    clientId: positiveInteger(value, "client_id"),
    role: role(value),
    accessToken: token(value, "access_token", "ofa_"),
    refreshToken: token(value, "refresh_token", "ofr_"),
    accessExpiresAt: isoTimestamp(value, "access_expires_at"),
    refreshExpiresAt: isoTimestamp(value, "refresh_expires_at"),
  };
}

function parsePrincipal(value: unknown): OmniFlowPrincipal {
  if (!isRecord(value)) {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }

  return {
    sessionId: requiredString(value, "session_id", 100),
    userId: positiveInteger(value, "user_id"),
    clientId: positiveInteger(value, "client_id"),
    role: role(value),
    email: requiredString(value, "email", 320),
    displayName: optionalString(value, "display_name", 255),
    accessExpiresAt: isoTimestamp(value, "access_expires_at"),
  };
}

async function errorCode(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && isRecord(payload.error)) {
      const code = payload.error.code;
      if (typeof code === "string" && /^[a-z0-9_]{1,100}$/.test(code)) {
        return code;
      }
    }
  } catch {
    // Upstream details are intentionally suppressed.
  }
  return response.status >= 500 ? "control_plane_unavailable" : "request_rejected";
}

async function controlPlaneRequest(
  path: string,
  init: RequestInit
): Promise<Response> {
  const url = new URL(path.replace(/^\//, ""), controlPlaneBaseUrl());
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Request-ID", randomUUID());

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
    throw new ControlPlaneRequestError(
      response.status,
      await errorCode(response)
    );
  }

  return response;
}

async function jsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ControlPlaneRequestError(502, "invalid_control_plane_response");
  }
}

export async function loginToControlPlane(
  input: LoginInput
): Promise<OmniFlowSessionTokens> {
  const body: Record<string, unknown> = {
    email: input.email,
    password: input.password,
  };
  if (input.clientId !== undefined) body.client_id = input.clientId;

  const response = await controlPlaneRequest("api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseTokens(await jsonResponse(response));
}

export async function refreshControlPlaneSession(
  refreshToken: string
): Promise<OmniFlowSessionTokens> {
  const response = await controlPlaneRequest("api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return parseTokens(await jsonResponse(response));
}

export async function getControlPlanePrincipal(
  accessToken: string
): Promise<OmniFlowPrincipal> {
  const response = await controlPlaneRequest("api/v1/auth/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return parsePrincipal(await jsonResponse(response));
}

export async function logoutControlPlaneSession(
  accessToken: string
): Promise<void> {
  await controlPlaneRequest("api/v1/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
