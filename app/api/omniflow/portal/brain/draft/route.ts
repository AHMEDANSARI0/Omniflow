import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  draftBrainReply,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    conversation_id?: unknown;
  } | null;
  const conversationId =
    payload && typeof payload.conversation_id === "number" &&
    Number.isInteger(payload.conversation_id) && payload.conversation_id > 0
      ? payload.conversation_id
      : 0;
  if (!conversationId) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "conversation_id (positive integer) is required.",
        },
      },
      400
    );
  }

  try {
    const result = await draftBrainReply(accessToken, conversationId);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
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
