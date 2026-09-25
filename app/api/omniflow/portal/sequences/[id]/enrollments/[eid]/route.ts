import {
  cancelSequenceEnrollment,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";


export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; eid: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id, eid } = await params;
  const sequenceId = Number.parseInt(id, 10);
  const enrollmentId = Number.parseInt(eid, 10);
  if (!Number.isFinite(sequenceId) || !Number.isFinite(enrollmentId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid id." } },
      400
    );
  }

  try {
    const result = await cancelSequenceEnrollment(
      accessToken,
      sequenceId,
      enrollmentId
    );
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Enrollment not found." } },
        404
      );
    }
    if (result.kind !== "ok") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
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
