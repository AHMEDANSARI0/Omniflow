import {
  listSegmentMembers,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


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

  const { id } = await params;
  const segmentId = Number.parseInt(id, 10);
  if (!Number.isFinite(segmentId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid segment id." } },
      400
    );
  }
  void request;

  try {
    const members = await listSegmentMembers(accessToken, segmentId);
    if (members === null) {
      return safeJson(
        { error: { code: "not_found", message: "Segment not found." } },
        404
      );
    }
    return safeJson({ members }, 200);
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
