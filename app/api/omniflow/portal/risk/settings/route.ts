import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getRiskSettings,
  putRiskSettings,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const payload = await getRiskSettings(accessToken);
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

export async function PUT(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    score_threshold?: unknown;
    staff_tasks?: unknown;
    city_default_pct?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.score_threshold !== "number" ||
    typeof payload.staff_tasks !== "boolean"
  ) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "score_threshold (number) and staff_tasks (boolean)"
                     + " are required.",
        },
      },
      400
    );
  }

  try {
    const ok = await putRiskSettings(accessToken, {
      score_threshold: payload.score_threshold,
      staff_tasks: payload.staff_tasks,
      city_default_pct:
        typeof payload.city_default_pct === "number"
          ? payload.city_default_pct
          : 30,
    });
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
