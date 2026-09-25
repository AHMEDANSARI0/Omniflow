import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  shareCheckoutLink,
} from "../../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../../lib/omniflow/request-security";

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}


export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const linkId = parseId(id);
  if (linkId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid link id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const message =
    typeof input.message === "string" ? input.message.trim().slice(0, 1000) : "";
  if (!message) {
    return safeJson(
      { error: { code: "bad_request", message: "Write a short message first." } },
      400
    );
  }

  try {
    const result = await shareCheckoutLink(accessToken, linkId, message);
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Link not found." } },
        404
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "This link has no customer contact." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
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
