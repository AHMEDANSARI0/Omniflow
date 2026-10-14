import { ControlPlaneRequestError } from "./control-plane";
import type { ServiceResult } from "./portal";
import { requirePortalAccessToken } from "./portal";
import { safeJson, sameOrigin } from "./request-security";

/** Shared BFF plumbing for the D5 voice / media-understanding routes. */
export async function withPortalToken(
  run: (accessToken: string) => Promise<Response>,
  request?: Request
): Promise<Response> {
  if (request && !sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    return await run(accessToken);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export function serviceResponse<T>(result: ServiceResult<T>): Response {
  if (result.kind === "ok") return safeJson(result.data, 200);
  if (result.kind === "invalid") {
    return safeJson(
      { error: { code: result.code, message: result.message } },
      result.status
    );
  }
  return safeJson(
    { error: { code: "portal_unavailable", message: "Try again shortly." } },
    503
  );
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const payload: unknown = await request.json().catch(() => null);
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}
