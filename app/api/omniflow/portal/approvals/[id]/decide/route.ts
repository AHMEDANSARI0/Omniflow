import {
  decideApproval,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!sameOrigin(request)) {
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
  const { id } = await context.params;
  const approvalId = Number(id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid approval id." } },
      400
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const decision = String(body.decision || "").trim().toLowerCase();
  if (decision !== "approve" && decision !== "reject") {
    return safeJson(
      { error: { code: "bad_request", message: "decision approve|reject." } },
      400
    );
  }
  try {
    const result = await decideApproval(accessToken, approvalId, decision);
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Pending approval nahi mili." } },
        404
      );
    }
    if (result === "conflict") {
      return safeJson(
        { error: { code: "conflict", message: "Already decided." } },
        409
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(
      { ok: true, status: decision === "approve" ? "approved" : "rejected" },
      200
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
