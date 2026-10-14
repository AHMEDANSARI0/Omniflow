import { saveSocialChannel } from "../../../../../../../lib/omniflow/portal";
import type { SocialChannelInput } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { isSocialChannel } from "../../../../../../../lib/omniflow/social-bff";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

interface RouteContext {
  params: Promise<{ channel: string }>;
}

const TEXT_FIELDS = ["app_id", "app_secret", "consumer_secret", "bearer_token", "organization_id"] as const;
const FLAG_KEYS = ["dm", "comments", "publish", "comment_auto_reply"] as const;

function bad(message: string) {
  return safeJson({ error: { code: "bad_request", message } }, 400);
}

/** Owners / admins: mode, app keys (write-only), switches. The Control Plane validates everything again. */
export async function PUT(request: Request, context: RouteContext) {
  const { channel } = await context.params;
  if (!isSocialChannel(channel)) return safeJson({ error: { code: "not_found", message: "Unknown channel." } }, 404);
  return withPortalToken(async (accessToken) => {
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
      if (!body.flags || typeof body.flags !== "object" || Array.isArray(body.flags)) return bad("flags must be an object.");
      const flags: NonNullable<SocialChannelInput["flags"]> = {};
      for (const [key, value] of Object.entries(body.flags as Record<string, unknown>)) {
        const known = FLAG_KEYS.find((flag) => flag === key);
        if (!known || typeof value !== "boolean") return bad("Unknown or invalid switch.");
        flags[known] = value;
      }
      input.flags = flags;
    }
    if (Object.keys(input).length === 0) return bad("Nothing to save.");
    return serviceResponse(await saveSocialChannel(accessToken, channel, input));
  }, request);
}
