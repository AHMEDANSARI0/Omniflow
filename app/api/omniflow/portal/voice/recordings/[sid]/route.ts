import {
  fetchVoiceRecording,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function GET(
  _request: Request,
  context: { params: Promise<{ sid: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { sid } = await context.params;
  const callSid = String(sid || "").trim().slice(0, 64);
  if (!/^[A-Za-z0-9]+$/.test(callSid)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid call id." } },
      400
    );
  }

  let response: Response;
  try {
    response = await fetchVoiceRecording(accessToken, callSid);
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

  if (!response.ok || !response.body) {
    if (response.status === 404) {
      return safeJson(
        { error: { code: "not_found", message: "Voicemail not found." } },
        404
      );
    }
    if (response.status === 409) {
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
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
