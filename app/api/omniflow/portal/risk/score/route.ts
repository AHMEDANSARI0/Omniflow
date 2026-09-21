import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getRiskScore,
  requirePortalAccessToken,
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
  const contact = (
    new URL(request.url).searchParams.get("contact") ?? ""
  ).trim();
  if (!contact) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }
  const totalRaw = new URL(request.url).searchParams.get("total");
  const address = new URL(request.url).searchParams.get("address") ?? "";
  const total = totalRaw ? Number.parseFloat(totalRaw) : 0;

  try {
    const payload = await getRiskScore(
      accessToken,
      contact,
      {
        total: Number.isFinite(total) ? total : undefined,
        address: address || undefined,
      }
    );
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
