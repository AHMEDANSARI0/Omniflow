import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  addConversationTag,
  removeConversationTag,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveConversationId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return null;
  return conversationId;
}

export async function POST(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    tag?: unknown;
  } | null;
  const tag = typeof payload?.tag === "string" ? payload.tag : "";
  if (!tag.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Label text is required." } },
      400
    );
  }

  try {
    const result = await addConversationTag(accessToken, conversationId, tag);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Labels can be up to 24 characters.",
          },
        },
        400
      );
    }
    if (result.kind === "limit_reached") {
      return safeJson(
        {
          error: {
            code: "limit_reached",
            message: "Up to 6 labels per conversation.",
          },
        },
        409
      );
    }
    return safeJson({ ok: true, duplicate: result.duplicate }, 200);
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

export async function DELETE(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const tag = new URL(request.url).searchParams.get("tag") || "";
  if (!tag.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Label text is required." } },
      400
    );
  }

  try {
    const result = await removeConversationTag(accessToken, conversationId, tag);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, missing: result === "missing" }, 200);
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
