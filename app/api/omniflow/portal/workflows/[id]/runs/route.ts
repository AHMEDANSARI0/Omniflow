import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  listWorkflowRuns,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

async function idFrom(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  return Number.parseInt(id ?? "", 10);
}

export async function GET(
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
  const limitRaw = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "20",
    10
  );
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 20;

  try {
    const runs = await listWorkflowRuns(accessToken, workflowId, limit);
    if (runs === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ runs }, 200);
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
