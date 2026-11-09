import { getControlPlanePrincipal } from "../../../../../../../lib/omniflow/control-plane";
import { createSocialPost, requirePortalAccessToken } from "../../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../../lib/omniflow/request-security";
import { isSocialChannel, publicOrigin } from "../../../../../../../lib/omniflow/social-bff";
import { jsonBody } from "../../../../../../../lib/omniflow/voice-vision-bff";
import { createWorkspaceSocialPostRecord } from "../../../../../../lib/workspace-store";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }
  const body = await jsonBody(request);
  const channel = typeof body.channel === "string" ? body.channel : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const mediaUrl = typeof body.media_url === "string" ? body.media_url.trim() : "";
  if (!isSocialChannel(channel)) {
    return safeJson({ error: { code: "bad_request", message: "Pick a channel." } }, 400);
  }
  if (text.length > 3000 || mediaUrl.length > 1500) {
    return safeJson({ error: { code: "bad_request", message: "The post is too long." } }, 400);
  }

  let clientId = 1;
  try {
    const p = await getControlPlanePrincipal(accessToken);
    clientId = p.clientId || 1;
  } catch {
    clientId = 1;
  }

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const cp = await createSocialPost(accessToken, channel, text, mediaUrl);
      if (cp.kind === "ok" && cp.data) {
        return safeJson(cp.data, 200);
      }
    } catch {
      // Fallback to local post creation
    }
  }

  const created = await createWorkspaceSocialPostRecord(
    clientId,
    channel,
    text,
    mediaUrl,
    publicOrigin(request)
  );
  return safeJson(created, 200);
}
