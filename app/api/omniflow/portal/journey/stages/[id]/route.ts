import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  deleteJourneyStage,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const { id: rawId } = await context.params;
  const parsed = Number.parseInt(rawId, 10);
  const id = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  if (!id) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid stage id." } },
      400
    );
  }

  try {
    const ok = await deleteJourneyStage(accessToken, id);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "No such stage." } },
        404
      );
    }
    return safeJson({ ok: true }, 200);
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
