import {
  saveSocialChannel,
  type SocialChannelInput,
  type SocialFeature,
  type SocialMode,
} from "../../../../../../../lib/omniflow/portal";
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

export async function PUT(
  request: Request,
  context: { params: Promise<{ channel: string }> }
) {
  const { channel: rawChannel } = await context.params;
  if (!isSocialChannel(rawChannel)) {
    return safeJson(
      { error: { code: "bad_request", message: "Unknown social channel." } },
      400
    );
  }

  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const mode: SocialMode | undefined =
      body.mode === "login" || body.mode === "api" ? body.mode : undefined;
    const input: SocialChannelInput = {
      mode,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      app_id: typeof body.app_id === "string" ? body.app_id.trim() : undefined,
      app_secret:
        typeof body.app_secret === "string" ? body.app_secret.trim() : undefined,
      consumer_secret:
        typeof body.consumer_secret === "string"
          ? body.consumer_secret.trim()
          : undefined,
      bearer_token:
        typeof body.bearer_token === "string"
          ? body.bearer_token.trim()
          : undefined,
      organization_id:
        typeof body.organization_id === "string"
          ? body.organization_id.trim()
          : undefined,
      flags:
        body.flags && typeof body.flags === "object"
          ? (body.flags as Partial<Record<SocialFeature | "comment_auto_reply", boolean>>)
          : undefined,
    };
    return serviceResponse(await saveSocialChannel(accessToken, rawChannel, input));
  }, request);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
