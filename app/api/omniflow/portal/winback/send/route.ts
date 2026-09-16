import {
  requirePortalAccessToken,
  sendWinbackEntry,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function POST(request: Request) {
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
  const contactId = typeof body.contact_id === "string" ? body.contact_id : "";
  const entryKind = typeof body.kind === "string" ? body.kind : "";
  if (!contactId || contactId.length > 100 || !entryKind) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id and kind are required." } },
      400
    );
  }

  try {
    const result = await sendWinbackEntry(accessToken, contactId, entryKind);
    if (result.kind === "ok") {
      return safeJson(
        { sent: true, kind: entryKind, command_id: result.commandId },
        200
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Contact not found." } },
        404
      );
    }
    if (result.kind === "cooldown") {
      return safeJson(
        {
          error: {
            code: "cooldown",
            message: "A win-back message was sent to this contact recently.",
          },
        },
        409
      );
    }
    if (result.kind === "stale") {
      return safeJson(
        {
          error: {
            code: "stale",
            message: "This suggestion is no longer in the queue.",
          },
        },
        409
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
