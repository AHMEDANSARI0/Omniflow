import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  cancelScheduledBroadcast,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


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

  const { id } = await params;
  const broadcastId = Number.parseInt(id, 10);
  if (!Number.isFinite(broadcastId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid broadcast id." } },
      400
    );
  }

  try {
    const result = await cancelScheduledBroadcast(accessToken, broadcastId);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        {
          error: {
            code: "not_found",
            message: "Scheduled broadcast not found (or already sent).",
          },
        },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
