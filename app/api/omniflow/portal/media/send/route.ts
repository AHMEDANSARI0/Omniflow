import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendMediaAsset,
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
    id?: unknown;
    contact_id?: unknown;
    conversation_id?: unknown;
    caption?: unknown;
  } | null;
  const id =
    payload && typeof payload.id === "number" &&
    Number.isInteger(payload.id) && payload.id > 0
      ? payload.id
      : 0;
  const contactId =
    payload && typeof payload.contact_id === "string"
      ? payload.contact_id.trim()
      : "";
  if (!id || !contactId) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "id and contact_id are required.",
        },
      },
      400
    );
  }

  try {
    const result = await sendMediaAsset(accessToken, {
      id,
      contact_id: contactId,
      conversation_id:
        typeof payload?.conversation_id === "number"
          ? payload.conversation_id
          : undefined,
      caption:
        typeof payload?.caption === "string" ? payload.caption : "",
    });
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
