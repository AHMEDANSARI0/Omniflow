import {
  requirePortalAccessToken,
  retryWebhookDelivery,
} from "../../../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../../../lib/omniflow/control-plane";


export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; did: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id, did } = await params;
  const webhookId = Number.parseInt(id, 10);
  const deliveryId = Number.parseInt(did, 10);
  if (!Number.isFinite(webhookId) || !Number.isFinite(deliveryId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid id." } },
      400
    );
  }

  try {
    const result = await retryWebhookDelivery(accessToken, webhookId, deliveryId);
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Delivery not found." } },
        404
      );
    }
    if (result.kind !== "ok") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(
      JSON.stringify({ delivered: result.delivered, status_code: result.statusCode }),
      { status: 200, headers: { ...noStoreHeaders(), "Content-Type": "application/json" } }
    );
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
