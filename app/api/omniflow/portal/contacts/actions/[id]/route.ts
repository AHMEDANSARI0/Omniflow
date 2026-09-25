import {
  requirePortalAccessToken,
  resolveContactAction,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const actionId = Number.parseInt(id, 10);
  if (!Number.isInteger(actionId) || actionId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid action id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const status = input.status;
  if (status !== "done" && status !== "declined") {
    return safeJson(
      { error: { code: "bad_request", message: "Pick done or declined." } },
      400
    );
  }

  try {
    const result = await resolveContactAction(accessToken, actionId, status);
    if (result.kind === "ok") {
      return safeJson({ ok: true, status }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Action not found." } },
        404
      );
    }
    return safeJson(
      { error: { code: "bad_request", message: "Pick done or declined." } },
      400
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
