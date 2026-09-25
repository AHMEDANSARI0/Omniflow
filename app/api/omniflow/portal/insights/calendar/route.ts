import {
  getBroadcastCalendar,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const month = (new URL(request.url).searchParams.get("month") || "").trim();
  if (month && !MONTH_RE.test(month)) {
    return safeJson(
      { error: { code: "bad_request", message: "month must look like 2026-09." } },
      400
    );
  }

  try {
    const calendar = await getBroadcastCalendar(accessToken, month);
    if (calendar === null) {
      return safeJson(
        { error: { code: "not_found", message: "Calendar unavailable." } },
        404
      );
    }
    return safeJson(calendar, 200);
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
