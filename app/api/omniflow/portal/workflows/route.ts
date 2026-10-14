import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createWorkflow,
  listWorkflows,
  type WorkflowWriteResult,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";
import { parseWorkflowPayload } from "../../../../../lib/omniflow/workflow-payload";

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

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const workflows = await listWorkflows(accessToken);
    if (workflows === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ workflows }, 200);
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

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const parsed = parseWorkflowPayload(await request.json().catch(() => null));
  if (!parsed.ok) {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const result = await createWorkflow(accessToken, parsed.input);
    return writeResponse(result, (r) => ({ workflow: r.workflow ?? null }));
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
