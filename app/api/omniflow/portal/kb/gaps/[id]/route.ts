import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  resolveKbGap,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const { id } = await context.params;
  const gapId = Number(id);
  if (!Number.isInteger(gapId) || gapId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid gap id." } },
      400
    );
  }

  try {
    const ok = await resolveKbGap(accessToken, gapId);
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
