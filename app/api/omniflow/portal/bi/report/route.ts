import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getBiReport,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = { error: { code: "portal_unavailable", message: "Try again shortly." } };

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const params = new URL(request.url).searchParams;
  const rawDays = Number.parseInt(params.get("days") ?? "", 10);
  const days = rawDays === 30 ? 30 : 7;

  try {
    const payload = await getBiReport(accessToken, days);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(payload, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
