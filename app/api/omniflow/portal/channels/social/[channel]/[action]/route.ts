import { getControlPlanePrincipal } from "../../../../../../../../lib/omniflow/control-plane";
import {
  SOCIAL_ACTIONS,
  requirePortalAccessToken,
  runSocialAction,
  startSocialOAuth,
} from "../../../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../../../lib/omniflow/request-security";
import {
  SOCIAL_CALLBACK_PATH,
  isSocialChannel,
  publicOrigin,
} from "../../../../../../../../lib/omniflow/social-bff";
import { runWorkspaceSocialAction } from "../../../../../../../lib/workspace-store";

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ channel: string; action: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const { channel, action } = await context.params;
  const known = SOCIAL_ACTIONS.find((value) => value === action);
  if (!isSocialChannel(channel) || (!known && action !== "connect")) {
    return safeJson({ error: { code: "not_found", message: "Unknown action." } }, 404);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }

  let clientId = 1;
  try {
    const p = await getControlPlanePrincipal(accessToken);
    clientId = p.clientId || 1;
  } catch {
    clientId = 1;
  }

  const origin = publicOrigin(request);

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const cp = !known
        ? await startSocialOAuth(accessToken, channel, origin + SOCIAL_CALLBACK_PATH)
        : await runSocialAction(accessToken, channel, known);
      if (cp.kind === "ok" && cp.data) {
        return safeJson(cp.data, 200);
      }
    } catch {
      // Fallback to local action
    }
  }

  const result = await runWorkspaceSocialAction(
    clientId,
    channel,
    known ? known : "connect",
    origin
  );
  return safeJson(result, 200);
}
