import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  verifyInstagramSettings,
} from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";

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
  try {
    const result = await verifyInstagramSettings(accessToken);
    if (result === "not_configured") {
      return safeJson(
        { error: { code: "not_configured", message: "Save the Instagram settings first." } },
        409
      );
    }
    if (result === "provider_error") {
      return safeJson(
        { error: { code: "provider_error", message: "Meta rejected the provider check." } },
        502
      );
    }
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
