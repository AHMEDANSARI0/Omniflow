import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";
import {
  listKbSourceVersions,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";

function parseId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (!id) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid source id." } },
      400
    );
  }

  try {
    const payload = await listKbSourceVersions(accessToken, id);
    if (payload === null) {
      return safeJson(
        { error: { code: "not_found", message: "No such source." } },
        404
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
