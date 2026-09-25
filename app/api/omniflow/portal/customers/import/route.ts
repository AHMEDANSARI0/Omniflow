import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  importCustomers,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const customers =
    payload !== null && typeof payload === "object"
      ? (payload as { customers?: unknown }).customers
      : null;
  if (!Array.isArray(customers)) {
    return safeJson(
      { error: { code: "bad_request", message: "customers list is required." } },
      400
    );
  }

  try {
    const result = await importCustomers(
      accessToken,
      customers as { name?: string; phone: string }[]
    );
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
