import { createSocialPost } from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { isSocialChannel } from "../../../../../../../lib/omniflow/social-bff";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const rawChannel = typeof body.channel === "string" ? body.channel.trim() : "";
    if (!isSocialChannel(rawChannel)) {
      return safeJson(
        { error: { code: "bad_request", message: "Choose a valid social channel." } },
        400
      );
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return safeJson(
        { error: { code: "bad_request", message: "Post text cannot be empty." } },
        400
      );
    }
    const mediaUrl = typeof body.media_url === "string" ? body.media_url.trim() : "";
    return serviceResponse(
      await createSocialPost(accessToken, rawChannel, text, mediaUrl)
    );
  }, request);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
