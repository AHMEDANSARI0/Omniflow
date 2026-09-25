import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createWebhook,
  listWebhooks,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const webhooks = await listWebhooks(accessToken);
    if (webhooks === null) {
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
    return safeJson({ webhooks }, 200);
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

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const url = typeof input.url === "string" ? input.url : "";
  const events = typeof input.events === "string" ? input.events : "all";
  if (!url) {
    return safeJson(
      { error: { code: "bad_request", message: "An https:// URL is required." } },
      400
    );
  }

  try {
    const result = await createWebhook(accessToken, url, events);
    if (result.kind === "ok") {
      return safeJson(
        { ok: true, webhook: result.webhook ?? null, secret: result.secret ?? null },
        200
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Check the URL and events, then try again.",
          },
        },
        400
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
