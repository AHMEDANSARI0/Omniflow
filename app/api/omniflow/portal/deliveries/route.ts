import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listDeliveries,
  requirePortalAccessToken,
  type DeliveryStatus,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

const STATUSES: DeliveryStatus[] = ["pending", "failed", "dead", "done"];

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const raw = new URL(request.url).searchParams.get("status") ?? "";
  const status = STATUSES.find((value) => value === raw);
  if (raw && !status) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "status must be pending, failed, dead or done.",
        },
      },
      400
    );
  }

  try {
    const payload = await listDeliveries(accessToken, status);
    if (payload === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(payload, 200);
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
