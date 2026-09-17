import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getDigestSettings,
  requirePortalAccessToken,
  saveDigestSettings,
} from "../../../../../lib/omniflow/portal";
import {
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
    const settings = await getDigestSettings(accessToken);
    if (settings === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Daily digest is not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ ok: true, settings }, 200);
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
  const raw =
    input.settings !== null && typeof input.settings === "object"
      ? (input.settings as Record<string, unknown>)
      : {};
  const settings = {
    enabled: raw.enabled === true,
    ownerContact:
      typeof raw.owner_contact === "string"
        ? raw.owner_contact.trim().slice(0, 100)
        : "",
    hour:
      typeof raw.hour === "number" && raw.hour >= 6 && raw.hour <= 21
        ? Math.floor(raw.hour)
        : 9,
  };
  if (settings.enabled && !settings.ownerContact) {
    return safeJson(
      { error: { code: "bad_request", message: "Your WhatsApp number is required to enable the digest." } },
      400
    );
  }

  try {
    const result = await saveDigestSettings(accessToken, settings);
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Digest hour must be between 6 and 21." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, settings }, 200);
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
