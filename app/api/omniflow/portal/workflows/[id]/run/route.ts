import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  runWorkflowNow,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

async function idFrom(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  return Number.parseInt(id ?? "", 10);
}

export async function POST(
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
  const workflowId = await idFrom(params);
  if (!Number.isFinite(workflowId) || workflowId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }
  const payload = (await request.json().catch(() => null)) as {
    conversation_id?: unknown;
  } | null;
  const conversationId =
    payload && typeof payload.conversation_id === "number"
      ? Math.round(payload.conversation_id)
      : 0;
  if (!Number.isFinite(conversationId) || conversationId <= 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "conversation_id (positive integer) is required.",
        },
      },
      400
    );
  }

  try {
    const result = await runWorkflowNow(accessToken, workflowId, conversationId);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Workflow or conversation not found." } },
        404
      );
    }
    if (result.kind === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: result.message } },
        400
      );
    }
    return safeJson({ ok: true, runId: result.runId, status: result.status }, 200);
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
