import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  listWorkflowVersions,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

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
  const { id } = await params;
  const workflowId = Number.parseInt(id ?? "", 10);
  if (!Number.isFinite(workflowId) || workflowId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }

  try {
    const result = await listWorkflowVersions(accessToken, workflowId);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "No such workflow." } },
        404
      );
    }
    return safeJson({ versions: result.versions }, 200);
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
