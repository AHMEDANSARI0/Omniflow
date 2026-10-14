import { testSmsChannel } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

export const maxDuration = 30;

/** Owners / admins: one test SMS from the workspace number (counts towards the daily limit). */
export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      return safeJson({ error: { code: "bad_request", message: "Use the full international format, e.g. +923001234567." } }, 400);
    }
    return serviceResponse(await testSmsChannel(accessToken, to));
  }, request);
}
