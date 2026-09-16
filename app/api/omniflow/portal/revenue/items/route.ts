import {
  getRevenueItems,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const params = new URL(request.url).searchParams;
  const rawDays = params.get("days");
  let days = 30;
  if (rawDays !== null) {
    const parsed = Number.parseInt(rawDays, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return safeJson(
        { error: { code: "bad_request", message: "days must be a number." } },
        400
      );
    }
    days = parsed;
  }

  try {
    const result = await getRevenueItems(accessToken, days);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ days, items: result }, 200);
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
