import {
  listVideoRooms,
  sendVideoInvite,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const rooms = await listVideoRooms(accessToken);
    if (rooms === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ rooms }, 200);
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
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const conversationId = Number(body.conversation_id || 0);
  const provider = String(body.provider || "").trim().toLowerCase();
  const title = String(body.title || "").trim().slice(0, 120);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      {
        error: { code: "bad_request", message: "conversation_id is required." },
      },
      400
    );
  }
  try {
    const result = await sendVideoInvite(
      accessToken,
      conversationId,
      provider || undefined,
      title || undefined
    );
    if (result === "not_configured") {
      return safeJson(
        {
          error: {
            code: "not_configured",
            message:
              "Video is not configured — add the provider key in the admin panel Integrations page.",
          },
        },
        409
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Check the request." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "room_failed",
            message: "The video provider rejected the room — check the saved keys.",
          },
        },
        502
      );
    }
    return safeJson(result, 200);
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
