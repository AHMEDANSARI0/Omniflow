import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  applyTemplate,
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
    vertical?: unknown;
    overwrite_persona?: unknown;
  } | null;
  const vertical =
    payload && typeof payload.vertical === "string"
      ? payload.vertical.trim()
      : "";
  if (!vertical) {
    return safeJson(
      { error: { code: "bad_request", message: "vertical is required." } },
      400
    );
  }
  try {
    const result = await applyTemplate(
      accessToken,
      vertical,
      payload?.overwrite_persona === true
    );
    if (result === null) {
      return safeJson(
        { error: { code: "bad_request", message: "Unknown vertical - refresh and pick again." } },
        400
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
