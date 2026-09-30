import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendWeeklyProblemsNow,
} from "../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = {
  error: { code: "portal_unavailable", message: "Try again shortly." },
};

export async function POST() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);

  try {
    const payload = await sendWeeklyProblemsNow(accessToken);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(
      {
        ok: payload.ok,
        title: payload.title,
        problem_counts: payload.problemCounts,
      },
      200
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
