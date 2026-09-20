import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";
import {
  decideChangeRequest,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../../lib/omniflow/request-security";


export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const requestId = Number.parseInt(id, 10);
  if (!Number.isFinite(requestId) || requestId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid request id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as { action?: unknown }).action
      : null;
  const action =
    raw === "approve" ? "approve" : raw === "decline" ? "decline" : null;
  if (!action) {
    return safeJson(
      {
        error: { code: "bad_request", message: "action must be approve or decline." },
      },
      400
    );
  }

  try {
    const result = await decideChangeRequest(accessToken, requestId, action);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "This request cannot be decided." } },
        400
      );
    }
    if (result === "conflict") {
      return safeJson(
        { error: { code: "conflict", message: "The order is not open anymore." } },
        409
      );
    }
    return safeJson({ ok: true, request: result.request }, 200);
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
