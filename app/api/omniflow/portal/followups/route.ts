import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getFollowupSettings,
  requirePortalAccessToken,
  saveFollowupSettings,
  type FollowupSettings,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getFollowupSettings(accessToken);
    if (settings === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ settings }, 200);
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
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    settings?: {
      enabled?: unknown;
      delayHours?: unknown;
      maxAttempts?: unknown;
      messageTemplate?: unknown;
    };
  } | null;
  const input = payload?.settings;
  if (!input) {
    return safeJson(
      { error: { code: "bad_request", message: "settings object is required." } },
      400
    );
  }

  const delayHours = Number(input.delayHours);
  const maxAttempts = Number(input.maxAttempts);
  const messageTemplate =
    typeof input.messageTemplate === "string" ? input.messageTemplate : "";
  if (!Number.isInteger(delayHours) || delayHours < 1 || delayHours > 168) {
    return safeJson(
      { error: { code: "bad_request", message: "Delay must be 1-168 hours." } },
      400
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    return safeJson(
      { error: { code: "bad_request", message: "Attempts must be 1-3." } },
      400
    );
  }
  if (messageTemplate.length > 1000) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Template must be under 1000 characters.",
        },
      },
      400
    );
  }

  const settings: FollowupSettings = {
    enabled: input.enabled === true,
    delayHours,
    maxAttempts,
    messageTemplate,
  };

  try {
    const ok = await saveFollowupSettings(accessToken, settings);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
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
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
