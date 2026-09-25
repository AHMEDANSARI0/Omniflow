import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  decideNegotiation,
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
    price?: unknown;
    offer?: unknown;
    conversation_id?: unknown;
    contact_id?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.price !== "number" ||
    typeof payload.offer !== "number" ||
    payload.price <= 0 ||
    payload.offer <= 0
  ) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "price and offer (positive numbers) are required.",
        },
      },
      400
    );
  }

  try {
    const result = await decideNegotiation(accessToken, {
      price: payload.price,
      offer: payload.offer,
      conversation_id:
        typeof payload.conversation_id === "number" &&
        Number.isInteger(payload.conversation_id) &&
        payload.conversation_id > 0
          ? payload.conversation_id
          : undefined,
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
