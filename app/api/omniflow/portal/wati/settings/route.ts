import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getWatiSettings,
  requirePortalAccessToken,
  saveWatiSettings,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getWatiSettings(accessToken);
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

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const enabled = input.enabled === true;
  const baseUrl = typeof input.base_url === "string" ? input.base_url.trim() : "";
  const apiToken = typeof input.api_token === "string" ? input.api_token.trim() : "";
  if (enabled && (!baseUrl || apiToken.length < 8)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Base URL (http/https) aur API token dono zaroori hain.",
        },
      },
      400
    );
  }

  try {
    const result = await saveWatiSettings(accessToken, {
      enabled,
      baseUrl,
      apiToken,
    });
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Check the WATI settings." } },
        400
      );
    }
    if (result === null) {
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
