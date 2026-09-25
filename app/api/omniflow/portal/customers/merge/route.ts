import {
  mergeCustomers,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const keep = typeof input.keep === "string" ? input.keep.trim() : "";
  const merge = typeof input.merge === "string" ? input.merge.trim() : "";
  if (!keep || !merge || keep.length > 100 || merge.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "Both contacts are required." } },
      400
    );
  }
  if (keep === merge) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick two different contacts." } },
      400
    );
  }

  try {
    const result = await mergeCustomers(accessToken, keep, merge);
    if (result.kind === "ok") {
      return safeJson({ ok: true, moved: result.moved }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        {
          error: {
            code: "not_found",
            message: "The duplicate contact has no chats.",
          },
        },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
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
