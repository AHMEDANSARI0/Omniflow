import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  setWorkflowStatus,
  type WorkflowWriteResult,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

async function idFrom(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  return Number.parseInt(id ?? "", 10);
}

function writeResponse(result: WorkflowWriteResult, okBody: (r: Extract<WorkflowWriteResult, { kind: "ok" }>) => unknown) {
  if (result === null) {
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
  if (result.kind === "not_found") {
    return safeJson(
      { error: { code: "not_found", message: "Workflow not found." } },
      404
    );
  }
  if (result.kind === "bad_request") {
    return safeJson(
      { error: { code: "bad_request", message: result.message } },
      400
    );
  }
  return safeJson(okBody(result), 200);
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
    status?: unknown;
  } | null;
  const status = payload && typeof payload.status === "string" ? payload.status : "";
  if (status !== "active" && status !== "paused") {
    return safeJson(
      { error: { code: "bad_request", message: "status must be active or paused." } },
      400
    );
  }

  try {
    const result = await setWorkflowStatus(accessToken, workflowId, status);
    return writeResponse(result, () => ({ ok: true, status }));
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
