import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendConversationMessage,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    body?: unknown;
  } | null;
  const body = payload && typeof payload.body === "string" ? payload.body : "";
  if (!body.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Message body is required." } },
      400
    );
  }

  try {
    const result = await sendConversationMessage(
      accessToken,
      conversationId,
      body.trim().slice(0, 4096)
    );
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
        404
      );
    }
    if (result.kind === "ok") {
      return safeJson(
        { ok: true, queued: result.queued, command_id: result.commandId },
        200
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
