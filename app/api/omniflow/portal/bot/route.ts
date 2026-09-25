import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getBotConfig,
  requirePortalAccessToken,
  saveBotConfig,
  type BotConfig,
} from "../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const config = await getBotConfig(accessToken);
    return safeJson(config);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as Partial<BotConfig> | null;
  if (!payload) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid request." } },
      400
    );
  }

  const config: BotConfig = {
    configured: true,
    agentName:
      typeof payload.agentName === "string" && payload.agentName.trim().length > 0
        ? payload.agentName.trim().slice(0, 120)
        : "OmniFlow Assistant",
    tone:
      payload.tone === "professional" || payload.tone === "concise"
        ? payload.tone
        : "friendly",
    greeting: typeof payload.greeting === "string" ? payload.greeting.slice(0, 1000) : "",
    fallback: typeof payload.fallback === "string" ? payload.fallback.slice(0, 1000) : "",
    workingHoursEnabled: payload.workingHoursEnabled === true,
    workingHoursStart:
      typeof payload.workingHoursStart === "string" && /^\d{2}:\d{2}$/.test(payload.workingHoursStart)
        ? payload.workingHoursStart
        : "09:00",
    workingHoursEnd:
      typeof payload.workingHoursEnd === "string" && /^\d{2}:\d{2}$/.test(payload.workingHoursEnd)
        ? payload.workingHoursEnd
        : "18:00",
    humanHandoffEnabled: payload.humanHandoffEnabled === true,
    customInstructions:
      typeof payload.customInstructions === "string"
        ? payload.customInstructions.slice(0, 2000)
        : "",
    updatedAt: null,
  };

  try {
    const result = await saveBotConfig(accessToken, config);
    return safeJson(result);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
