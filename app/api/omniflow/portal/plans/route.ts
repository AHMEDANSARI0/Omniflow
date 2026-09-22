import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getPlans,
  putPlan,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const result = await getPlans(accessToken);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(result, 200);
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
    plan?: unknown;
  } | null;
  const plan =
    payload && typeof payload.plan === "string" ? payload.plan.trim() : "";
  if (!plan) {
    return safeJson(
      { error: { code: "bad_request", message: "plan is required." } },
      400
    );
  }
  try {
    const ok = await putPlan(accessToken, plan);
    if (!ok) {
      return safeJson(
        { error: { code: "bad_request", message: "Unknown plan - pick one from the list." } },
        400
      );
    }
    return safeJson({ ok: true, plan }, 200);
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
