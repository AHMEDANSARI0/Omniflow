import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getGrowthBundle,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

function parseDays(request: Request): number {
  const raw = new URL(request.url).searchParams.get("days") ?? "14";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 14;
  return Math.min(90, parsed);
}

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const result = await getGrowthBundle(accessToken, parseDays(request));
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "bundle_disabled") {
      return safeJson(
        {
          error: {
            code: "bundle_disabled",
            message: "Growth bundle is off; use the individual endpoints.",
          },
        },
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
