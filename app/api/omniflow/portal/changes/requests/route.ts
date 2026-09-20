import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listChangeRequests,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const raw = (url.searchParams.get("status") || "pending").trim();
  const statusFilter = (["pending", "approved", "declined", "all"] as const).find(
    (value) => value === raw
  );
  if (!statusFilter) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "status must be all, pending, approved, or declined.",
        },
      },
      400
    );
  }

  try {
    const data = await listChangeRequests(accessToken, statusFilter);
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
