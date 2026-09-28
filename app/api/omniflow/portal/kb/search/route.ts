import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  searchKnowledge,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim().slice(0, 300);
  if (!query) {
    return safeJson(
      { error: { code: "bad_request", message: "q is required." } },
      400
    );
  }
  const rawN = Number.parseInt(params.get("n") ?? "", 10);
  const n = Number.isFinite(rawN) && rawN > 0 ? Math.min(rawN, 10) : 5;

  try {
    const payload = await searchKnowledge(accessToken, query, n);
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
