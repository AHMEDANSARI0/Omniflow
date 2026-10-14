import {
  requirePortalAccessToken,
  testPolicyRule,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";

export async function POST(request: Request) {
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
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rules = body.rules;
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
    return safeJson(
      { error: { code: "bad_request", message: "rules object zaroori hai." } },
      400
    );
  }
  const context =
    body.context !== null && typeof body.context === "object"
      ? (body.context as Record<string, unknown>)
      : {};
  try {
    const matched = await testPolicyRule(
      accessToken,
      rules as Record<string, unknown>,
      context
    );
    if (matched === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ matched }, 200);
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
