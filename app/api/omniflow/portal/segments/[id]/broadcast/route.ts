import {
  broadcastToSegment,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


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
  const segmentId = Number.parseInt(id, 10);
  if (!Number.isFinite(segmentId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid segment id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > 1000) {
    return safeJson(
      { error: { code: "bad_request", message: "A message (1-1000 chars) is required." } },
      400
    );
  }

  try {
    const result = await broadcastToSegment(accessToken, segmentId, body);
    if (result.kind === "ok") {
      return safeJson({ ok: true, sent: result.sent }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "No members match this segment right now.",
          },
        },
        400
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
