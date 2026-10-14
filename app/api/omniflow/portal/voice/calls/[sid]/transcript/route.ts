import { getVoiceCallTranscript } from "../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../../lib/omniflow/voice-vision-bff";

/** What the caller and the phone assistant said on one call (D5). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sid: string }> }
) {
  const { sid } = await context.params;
  const callSid = String(sid || "").trim().slice(0, 64);
  if (!/^[A-Za-z0-9]+$/.test(callSid)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid call id." } },
      400
    );
  }
  return withPortalToken(async (token) =>
    serviceResponse(await getVoiceCallTranscript(token, callSid))
  );
}
