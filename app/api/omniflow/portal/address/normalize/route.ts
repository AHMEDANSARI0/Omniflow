import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  normalizeAddress,
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
    address?: unknown;
  } | null;
  const address =
    payload && typeof payload.address === "string" ? payload.address : "";
  if (!address.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "address is required." } },
      400
    );
  }

  try {
    const result = await normalizeAddress(accessToken, address);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
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
