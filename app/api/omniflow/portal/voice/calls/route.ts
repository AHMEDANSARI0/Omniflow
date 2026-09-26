import {
  callContact,
  listVoiceCalls,
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
    const calls = await listVoiceCalls(accessToken);
    if (calls === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ calls }, 200);
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
  const contactId = String(body.contact_id || "").trim().slice(0, 100);
  const phone = String(body.phone || "").trim();
  const message = String(body.message || "").trim().slice(0, 300);
  if (!contactId) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id is required." } },
      400
    );
  }
  if (!phone.startsWith("+") || !phone.slice(1).replace(/\d/g, "")) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Enter the number in +92300... format.",
        },
      },
      400
    );
  }
  if (!message) {
    return safeJson(
      { error: { code: "bad_request", message: "Write a short message." } },
      400
    );
  }
  try {
    const result = await callContact(accessToken, contactId, phone, message);
    if (result === "not_configured") {
      return safeJson(
        {
          error: {
            code: "not_configured",
            message:
              "Voice is not configured — add the Twilio keys in the admin panel Integrations page.",
          },
        },
        409
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Check the number and message." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "call_failed",
            message: "Twilio rejected the call — check the saved keys.",
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
