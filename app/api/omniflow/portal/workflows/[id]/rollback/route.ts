import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  rollbackWorkflow,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

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
  const { id } = await params;
  const workflowId = Number.parseInt(id ?? "", 10);
  if (!Number.isFinite(workflowId) || workflowId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }
  const payload = (await request.json().catch(() => null)) as {
    version?: unknown;
  } | null;
  const version =
    payload && typeof payload.version === "number" ? payload.version : 0;
  if (!Number.isInteger(version) || version <= 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "version must be a positive integer.",
        },
      },
      400
    );
  }

  try {
    const result = await rollbackWorkflow(accessToken, workflowId, version);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "No such workflow version." } },
        404
      );
    }
    if (result.kind === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: result.message } },
        400
      );
    }
    return safeJson(
      { ok: true, version: result.version, restored_from: result.restoredFrom },
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
