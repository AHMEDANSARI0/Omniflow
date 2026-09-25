import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  addJourneyStage,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    name?: unknown;
  } | null;
  const name =
    payload && typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) {
    return safeJson(
      { error: { code: "bad_request", message: "name is required." } },
      400
    );
  }

  try {
    const ok = await addJourneyStage(accessToken, name);
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
