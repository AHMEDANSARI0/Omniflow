import { getSmsChannel, saveSmsChannel } from "../../../../../../lib/omniflow/portal";
import type { SmsChannelInput } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

function bad(message: string) {
  return safeJson({ error: { code: "bad_request", message } }, 400);
}

/** §244 SMS channel: on / off, daily limit, today's count and recent texts. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getSmsChannel(accessToken)));
}

/** Owners / admins only; the Control Plane checks the platform keys, the assigned number and the limit range. */
export async function PUT(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const input: SmsChannelInput = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return bad("enabled must be true or false.");
      input.enabled = body.enabled;
    }
    if (body.daily_limit !== undefined) {
      if (typeof body.daily_limit !== "number" || !Number.isInteger(body.daily_limit) || body.daily_limit < 1) {
        return bad("The daily limit must be a whole number.");
      }
      input.daily_limit = body.daily_limit;
    }
    if (input.enabled === undefined && input.daily_limit === undefined) return bad("Nothing to save.");
    return serviceResponse(await saveSmsChannel(accessToken, input));
  }, request);
}
