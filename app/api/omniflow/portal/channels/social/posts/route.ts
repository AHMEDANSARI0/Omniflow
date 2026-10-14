import { createSocialPost } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { isSocialChannel } from "../../../../../../../lib/omniflow/social-bff";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

export const maxDuration = 60;

/** Owners / admins publish; other teammates' posts wait for an approval (Control Plane decides). */
export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const mediaUrl = typeof body.media_url === "string" ? body.media_url.trim() : "";
    if (!isSocialChannel(channel)) return safeJson({ error: { code: "bad_request", message: "Pick a channel." } }, 400);
    if (text.length > 3000 || mediaUrl.length > 1500) {
      return safeJson({ error: { code: "bad_request", message: "The post is too long." } }, 400);
    }
    return serviceResponse(await createSocialPost(accessToken, channel, text, mediaUrl));
  }, request);
}
