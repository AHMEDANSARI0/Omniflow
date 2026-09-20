import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createCoupon,
  listCoupons,
  requirePortalAccessToken,
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
    const data = await listCoupons(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
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


export async function POST(request: Request) {
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
  const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
  const kind = input.kind === "percent" ? "percent" : input.kind === "fixed" ? "fixed" : null;
  const value = typeof input.value === "number" ? input.value : Number.NaN;
  if (!code || !kind || !Number.isFinite(value)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Code (3-24 letters/numbers), kind and value are required.",
        },
      },
      400
    );
  }
  const minTotal = typeof input.min_total === "number" ? input.min_total : 0;
  const usageLimit = typeof input.usage_limit === "number" ? input.usage_limit : null;
  const expiresDays =
    typeof input.expires_in_days === "number" ? input.expires_in_days : null;

  try {
    const result = await createCoupon(accessToken, {
      code,
      kind,
      value,
      min_total: minTotal,
      usage_limit: usageLimit,
      expires_in_days: expiresDays,
    });
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "conflict") {
      return safeJson(
        { error: { code: "conflict", message: "A coupon with this code already exists." } },
        409
      );
    }
    if ("error" in result) {
      return safeJson(
        { error: { code: "bad_request", message: result.error } },
        400
      );
    }
    return safeJson({ ok: true, coupon: result.coupon }, 200);
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
