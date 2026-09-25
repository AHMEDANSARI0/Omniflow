import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  putAlertSettings,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

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

  try {
    const ok = await putAlertSettings(accessToken, payload.enabled);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ settings: { enabled: payload.enabled } }, 200);
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
