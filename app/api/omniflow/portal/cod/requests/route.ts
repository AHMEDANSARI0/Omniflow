import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listCodRequests,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";

const ALLOWED = new Set(["all", "pending", "confirmed", "declined"]);


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  let status = "all";
  try {
    const raw = new URL(request.url).searchParams.get("status");
    if (raw && ALLOWED.has(raw)) status = raw;
  } catch {
    status = "all";
  }

  try {
    const result = await listCodRequests(
      accessToken,
      status as "all" | "pending" | "confirmed" | "declined"
    );
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "COD confirmations are not available yet.",
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
