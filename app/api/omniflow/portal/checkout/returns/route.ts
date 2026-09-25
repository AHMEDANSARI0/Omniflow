import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listCheckoutReturns,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const result = await listCheckoutReturns(accessToken);
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Returns are not available yet.",
          },
        },
        503
      );
    }
    return safeJson(
      { ok: true, returns: result.returns, counts: { total: result.total } },
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
