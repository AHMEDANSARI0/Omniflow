import {
  listWebhookDeliveries,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const webhookId = Number.parseInt(id, 10);
  if (!Number.isFinite(webhookId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid webhook id." } },
      400
    );
  }

  try {
    const deliveries = await listWebhookDeliveries(accessToken, webhookId);
    if (deliveries === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Integrations are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ deliveries }, 200);
  } catch {
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
