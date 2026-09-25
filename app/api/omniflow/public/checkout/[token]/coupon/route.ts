import {
  applyPublicCoupon,
  removePublicCoupon,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const clean = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!clean) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid order link." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).code
      : null;
  const code = typeof raw === "string" ? raw.trim().toUpperCase().slice(0, 24) : "";
  if (!code) {
    return safeJson(
      { error: { code: "bad_request", message: "Enter a coupon code first." } },
      400
    );
  }

  try {
    const result = await applyPublicCoupon(clean, code);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if ("error" in result) {
      const status = result.error.includes("not valid") ? 404 : 400;
      return safeJson(
        { error: { code: "bad_request", message: result.error } },
        status
      );
    }
    return safeJson(result, 200);
  } catch {
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}


export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const clean = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!clean) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid order link." } },
      400
    );
  }

  try {
    const result = await removePublicCoupon(clean);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if ("error" in result) {
      return safeJson(
        { error: { code: "bad_request", message: result.error } },
        404
      );
    }
    return safeJson(result, 200);
  } catch {
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
