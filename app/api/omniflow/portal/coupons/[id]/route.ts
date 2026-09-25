import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteCoupon,
  requirePortalAccessToken,
  setCouponActive,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}


export async function PATCH(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const couponId = Number.parseInt(id, 10);
  if (!Number.isFinite(couponId) || couponId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid coupon id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const isActive =
    payload !== null &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).is_active === true;
  const explicit =
    payload !== null &&
    typeof payload === "object" &&
    "is_active" in (payload as Record<string, unknown>);
  if (!explicit) {
    return safeJson(
      { error: { code: "bad_request", message: "is_active must be true or false." } },
      400
    );
  }

  try {
    const ok = await setCouponActive(accessToken, couponId, isActive);
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


export async function DELETE(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const couponId = Number.parseInt(id, 10);
  if (!Number.isFinite(couponId) || couponId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid coupon id." } },
      400
    );
  }

  try {
    const ok = await deleteCoupon(accessToken, couponId);
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
