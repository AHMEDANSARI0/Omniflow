import "server-only";

import { ControlPlaneRequestError } from "./control-plane";


const REQUEST_TIMEOUT_MS = 8_000;

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

async function controlPlaneRequest(
  path: string,
  init: RequestInit
): Promise<Response> {
  const url = new URL(path.replace(/^\//, ""), controlPlaneBaseUrl());
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

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
    throw new ControlPlaneRequestError(response.status, "request_rejected");
  }

  return response;
}

/**
 * Requests a 6-digit reset code for the given email. The control plane
 * responds with success whether or not the account exists (anti-enumeration),
 * so callers must show the same message either way.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await controlPlaneRequest("api/v1/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function resetPasswordWithCode(
  code: string,
  newPassword: string
): Promise<void> {
  await controlPlaneRequest("api/v1/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, new_password: newPassword }),
  });
}
