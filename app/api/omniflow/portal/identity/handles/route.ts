import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  addIdentityHandle,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

const MAX_HANDLE_LENGTH = 200;

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    contact?: unknown;
    channel?: unknown;
    handle?: unknown;
  } | null;
  const contact =
    payload && typeof payload.contact === "string" ? payload.contact.trim() : "";
  const channel =
    payload && typeof payload.channel === "string"
      ? payload.channel.trim().toLowerCase()
      : "";
  const handle =
    payload && typeof payload.handle === "string" ? payload.handle.trim() : "";
  if (!contact || !channel || !handle || handle.length > MAX_HANDLE_LENGTH) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "contact, channel and handle are required.",
        },
      },
      400
    );
  }

  try {
    const result = await addIdentityHandle(accessToken, contact, channel, handle);
    if (result.kind === "unavailable") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: result.message } },
        400
      );
    }
    if (result.kind === "conflict") {
      return safeJson(
        {
          error: { code: "identity_conflict", message: result.message },
          other_contact: result.other_contact,
        },
        409
      );
    }
    return safeJson({ ok: true, handle: result.handle }, 200);
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
