import {
  getCustomerProfile,
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

  const contact = (new URL(request.url).searchParams.get("contact") || "").trim();
  if (!contact || contact.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }

  try {
    const profile = await getCustomerProfile(accessToken, contact);
    if (profile === null) {
      return safeJson(
        { error: { code: "not_found", message: "Customer not found." } },
        404
      );
    }
    return safeJson(profile, 200);
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
