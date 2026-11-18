import {
  runSocialAction,
  SOCIAL_ACTIONS,
  startSocialOAuth,
  type SocialAction,
} from "../../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../../lib/omniflow/request-security";
import {
  isSocialChannel,
  publicOrigin,
  SOCIAL_CALLBACK_PATH,
} from "../../../../../../../../lib/omniflow/social-bff";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../../lib/omniflow/voice-vision-bff";

function isSocialAction(value: string): value is SocialAction {
  return (SOCIAL_ACTIONS as readonly string[]).includes(value);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ channel: string; action: string }> }
) {
  const { channel: rawChannel, action } = await context.params;
  if (!isSocialChannel(rawChannel)) {
    return safeJson(
      { error: { code: "bad_request", message: "Unknown social channel." } },
      400
    );
  }

  if (action === "connect") {
    return withPortalToken(async (accessToken) => {
      const redirectUri = publicOrigin(request) + SOCIAL_CALLBACK_PATH;
      return serviceResponse(
        await startSocialOAuth(accessToken, rawChannel, redirectUri)
      );
    }, request);
  }

  if (!isSocialAction(action)) {
    return safeJson(
      { error: { code: "bad_request", message: "Unknown social action." } },
      400
    );
  }

  return withPortalToken(
    async (accessToken) =>
      serviceResponse(await runSocialAction(accessToken, rawChannel, action)),
    request
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
