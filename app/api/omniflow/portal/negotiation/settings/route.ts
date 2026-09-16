import {
  getNegotiationSettings,
  requirePortalAccessToken,
  saveNegotiationSettings,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getNegotiationSettings(accessToken);
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
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const enabled = body.enabled === true;
  const floorPercent = Number(body.floor_percent ?? 0);
  const maxPercent = Number(body.max_percent ?? 25);
  if (!Number.isFinite(floorPercent) || floorPercent < 0 || floorPercent > 70) {
    return safeJson(
      { error: { code: "bad_request", message: "floor_percent must be 0-70." } },
      400
    );
  }
  if (!Number.isFinite(maxPercent) || maxPercent < 0 || maxPercent > 70) {
    return safeJson(
      { error: { code: "bad_request", message: "max_percent must be 0-70." } },
      400
    );
  }
  if (maxPercent < floorPercent) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "max_percent must be at least floor_percent.",
        },
      },
      400
    );
  }

  try {
    const saved = await saveNegotiationSettings(
      accessToken,
      enabled,
      Math.round(floorPercent),
      Math.round(maxPercent)
    );
    if (saved === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ settings: saved }, 200);
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
