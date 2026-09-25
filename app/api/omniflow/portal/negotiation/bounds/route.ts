import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getPriceBounds,
  putPriceBounds,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getPriceBounds(accessToken);
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
    enabled?: unknown;
    min_price?: unknown;
    max_discount_pct?: unknown;
  } | null;
  if (!payload || typeof payload.enabled !== "boolean") {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "enabled (boolean) is required.",
        },
      },
      400
    );
  }
  if (
    typeof payload.min_price !== "number" ||
    typeof payload.max_discount_pct !== "number" ||
    payload.min_price < 0 ||
    payload.max_discount_pct < 0 ||
    payload.max_discount_pct > 90
  ) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message:
            "min_price >= 0 and max_discount_pct within 0..90 are required.",
        },
      },
      400
    );
  }

  try {
    const ok = await putPriceBounds(accessToken, {
      enabled: payload.enabled,
      min_price: payload.min_price,
      max_discount_pct: payload.max_discount_pct,
    });
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(
      {
        settings: {
          enabled: payload.enabled,
          min_price: payload.min_price,
          max_discount_pct: payload.max_discount_pct,
        },
      },
      200
    );
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
