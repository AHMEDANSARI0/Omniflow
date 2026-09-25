import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listBroadcasts,
  requirePortalAccessToken,
  sendBroadcast,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listBroadcasts(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    audience?: unknown;
    body?: unknown;
  } | null;
  const audience =
    payload?.audience === "open" || payload?.audience === "hot"
      ? payload.audience
      : "all";
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text is required." } },
      400
    );
  }
  if (body.length > 1000) {
    return safeJson(
      { error: { code: "bad_request", message: "Broadcasts must be 1000 characters or fewer." } },
      400
    );
  }

  try {
    const result = await sendBroadcast(accessToken, audience, body);
    if (result.kind === "ok") {
      return safeJson(
        { ok: true, broadcast: result.broadcast, recipients: result.recipients },
        200
      );
    }
    if (result.kind === "no_recipients") {
      return safeJson(
        {
          error: {
            code: "no_recipients",
            message: "No conversations match this audience yet.",
          },
        },
        400
      );
    }
    if (result.kind === "too_many") {
      return safeJson(
        {
          error: {
            code: "too_many_recipients",
            message:
              "Audience has more than 200 customers. Narrow it down (open chats or hot leads).",
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
