import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendCustomerMessage,
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

  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const contactId = typeof body.contact_id === "string" ? body.contact_id.trim().slice(0, 120) : "";
  const text = typeof body.body === "string" ? body.body.trim().slice(0, 1000) : "";
  if (!contactId || !text) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id and message text are required." } },
      400
    );
  }

  try {
    const result = await sendCustomerMessage(accessToken, contactId, text);
    if (result.kind === "ok") {
      return safeJson({ ok: true, command_id: result.commandId }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Message must be 1-1000 characters." } },
        400
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "contact_not_found", message: "No WhatsApp chat exists for this contact." } },
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
