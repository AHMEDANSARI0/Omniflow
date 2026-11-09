import { getControlPlanePrincipal } from "../../../../../../../lib/omniflow/control-plane";
import { requirePortalAccessToken, saveSocialChannel } from "../../../../../../../lib/omniflow/portal";
import type { SocialChannelInput } from "../../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../../lib/omniflow/request-security";
import { isSocialChannel, publicOrigin } from "../../../../../../../lib/omniflow/social-bff";
import { jsonBody } from "../../../../../../../lib/omniflow/voice-vision-bff";
import { saveWorkspaceSocialChannel } from "../../../../../../lib/workspace-store";

interface RouteContext {
  params: Promise<{ channel: string }>;
}

const TEXT_FIELDS = ["app_id", "app_secret", "consumer_secret", "bearer_token", "organization_id"] as const;
const FLAG_KEYS = ["dm", "comments", "publish", "comment_auto_reply"] as const;

function bad(message: string) {
  return safeJson({ error: { code: "bad_request", message } }, 400);
}

export async function PUT(request: Request, context: RouteContext) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const { channel } = await context.params;
  if (!isSocialChannel(channel)) {
    return safeJson({ error: { code: "not_found", message: "Unknown channel." } }, 404);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }
  const body = await jsonBody(request);
  const input: SocialChannelInput = {};
  if (body.mode !== undefined) {
    if (body.mode !== "api" && body.mode !== "login") return bad("mode must be api or login.");
    input.mode = body.mode;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return bad("enabled must be true or false.");
    input.enabled = body.enabled;
  }
  for (const key of TEXT_FIELDS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 500) return bad(key + " must be text.");
    input[key] = value.trim();
  }
  if (body.flags !== undefined) {
    if (!body.flags || typeof body.flags !== "object" || Array.isArray(body.flags)) {
      return bad("flags must be an object.");
    }
    const flags: NonNullable<SocialChannelInput["flags"]> = {};
    for (const [key, value] of Object.entries(body.flags as Record<string, unknown>)) {
      const known = FLAG_KEYS.find((flag) => flag === key);
      if (!known || typeof value !== "boolean") return bad("Unknown or invalid switch.");
      flags[known] = value;
    }
    input.flags = flags;
  }

  let clientId = 1;
  try {
    const p = await getControlPlanePrincipal(accessToken);
    clientId = p.clientId || 1;
  } catch {
    clientId = 1;
  }

  const saved = await saveWorkspaceSocialChannel(
    clientId,
    channel,
    {
      ...input,
      account_name: typeof body.account_name === "string" ? body.account_name.trim() : undefined,
      access_token: typeof body.access_token === "string" ? body.access_token.trim() : undefined,
    },
    publicOrigin(request)
  );

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const cp = await saveSocialChannel(accessToken, channel, input);
      if (cp.kind === "ok" && cp.data) {
        return safeJson(cp.data, 200);
      }
    } catch {
      // Fallback to local saved state
    }
  }

  return safeJson(saved, 200);
}
