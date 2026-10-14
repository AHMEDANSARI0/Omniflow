import { SOCIAL_ACTIONS, runSocialAction, startSocialOAuth } from "../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";
import { SOCIAL_CALLBACK_PATH, isSocialChannel, publicOrigin } from "../../../../../../../../lib/omniflow/social-bff";
import { serviceResponse, withPortalToken } from "../../../../../../../../lib/omniflow/voice-vision-bff";

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ channel: string; action: string }>;
}

/** Owners / admins: connect (OAuth start), test, webhook, sync ("Check now"), disconnect. */
export async function POST(request: Request, context: RouteContext) {
  const { channel, action } = await context.params;
  const known = SOCIAL_ACTIONS.find((value) => value === action);
  if (!isSocialChannel(channel) || (!known && action !== "connect")) {
    return safeJson({ error: { code: "not_found", message: "Unknown action." } }, 404);
  }
  return withPortalToken(async (accessToken) => {
    if (!known) {
      return serviceResponse(await startSocialOAuth(accessToken, channel, publicOrigin(request) + SOCIAL_CALLBACK_PATH));
    }
    return serviceResponse(await runSocialAction(accessToken, channel, known));
  }, request);
}
