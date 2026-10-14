import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  archiveWorkflow,
  getWorkflow,
  updateWorkflow,
  type WorkflowWriteResult,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { parseWorkflowPayload } from "../../../../../../lib/omniflow/workflow-payload";

async function idFrom(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  return Number.parseInt(id ?? "", 10);
}

function badId() {
  return safeJson(
    { error: { code: "bad_request", message: "id is required." } },
    400
  );
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

export async function GET(
  _request: Request,
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
  if (!Number.isFinite(workflowId) || workflowId <= 0) return badId();

  try {
    const workflow = await getWorkflow(accessToken, workflowId);
    if (workflow === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Workflow not found." } },
        404
      );
    }
    if (workflow === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ workflow }, 200);
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

export async function PUT(
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
  if (!Number.isFinite(workflowId) || workflowId <= 0) return badId();
  const parsed = parseWorkflowPayload(await request.json().catch(() => null));
  if (!parsed.ok) {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const result = await updateWorkflow(accessToken, workflowId, parsed.input);
    return writeResponse(result, (r) => ({ ok: true, version: r.version ?? null }));
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

export async function DELETE(
  _request: Request,
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
  if (!Number.isFinite(workflowId) || workflowId <= 0) return badId();

  try {
    const result = await archiveWorkflow(accessToken, workflowId);
    return writeResponse(result, () => ({ ok: true }));
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
