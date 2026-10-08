import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import { isMetaSetupFix, requirePortalAccessToken, runMetaSetup } from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";

/**
 * §256 Meta setup check. Body `{}` runs the live check; `{ "fix": ... }`
 * runs one Graph API fix (Page subscription or app webhooks) and answers
 * with a fresh check.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }
  const body: unknown = await request.json().catch(() => ({}));
  const fix = body !== null && typeof body === "object" ? (body as Record<string, unknown>).fix : undefined;
  if (fix !== undefined && !isMetaSetupFix(fix)) {
    return safeJson({ error: { code: "bad_request", message: "Unknown fix." } }, 400);
  }
  try {
    const result = await runMetaSetup(accessToken, fix ?? null);
    if (result === null) {
      return safeJson({ error: { code: "portal_unavailable", message: "Try again shortly." } }, 503);
    }
    if ("failed" in result) {
      return safeJson({ error: { code: "setup_failed", message: result.failed } }, result.status === 403 ? 403 : 409);
    }
    return safeJson({ ok: true, ...result }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson({ error: { code: "unauthorized", message: "Session expired." } }, 401);
    }
    return safeJson({ error: { code: "portal_unavailable", message: "Try again shortly." } }, 503);
  }
}
