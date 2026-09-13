import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listScheduledBroadcasts,
  requirePortalAccessToken,
  scheduleBroadcast,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const scheduled = await listScheduledBroadcasts(accessToken);
    if (scheduled === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Scheduled broadcasts are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ scheduled }, 200);
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
  const audience = typeof input.audience === "string" ? input.audience : "all";
  const body = typeof input.body === "string" ? input.body : "";
  const sendAt = typeof input.send_at === "string" ? input.send_at : "";
  if (!body || !sendAt) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text and time are required." } },
      400
    );
  }

  try {
    const result = await scheduleBroadcast(accessToken, audience, body, sendAt);
    if (result.kind === "ok") {
      return safeJson({ ok: true, scheduled: result.scheduled }, 200);
    }
    if (result.kind === "no_recipients") {
      return safeJson(
        { error: { code: "no_recipients", message: "No conversations match this audience yet." } },
        400
      );
    }
    if (result.kind === "too_many_recipients") {
      return safeJson(
        {
          error: {
            code: "too_many_recipients",
            message: "Audience has more than 200 customers. Narrow it down.",
          },
        },
        400
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Pick a valid future time." } },
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
