import {
  listContactActions,
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
  const contact = (params.get("contact") || "").trim();
  const status = (params.get("status") || "").trim();
  if (contact.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is too long." } },
      400
    );
  }
  if (status && !["pending", "done", "declined"].includes(status)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "status must be pending, done or declined.",
        },
      },
      400
    );
  }

  try {
    const actions = await listContactActions(accessToken, contact, status);
    if (actions === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ actions }, 200);
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
