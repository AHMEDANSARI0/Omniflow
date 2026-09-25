import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteSavedReply,
  requirePortalAccessToken,
  updateSavedReply,
  type SavedReplyMutation,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveReplyId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const replyId = Number(id);
  if (!Number.isInteger(replyId) || replyId <= 0) return null;
  return replyId;
}

export async function DELETE(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const replyId = await resolveReplyId(context);
  if (replyId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid saved reply id." } },
      400
    );
  }

  try {
    const result = await deleteSavedReply(accessToken, replyId);
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

export async function PUT(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const replyId = await resolveReplyId(context);
  if (replyId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid saved reply id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const shortcut = typeof input.shortcut === "string" ? input.shortcut.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!shortcut || shortcut.length > 24 || !body || body.length > 1000) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "A shortcut (max 24) and message (max 1000) are required.",
        },
      },
      400
    );
  }

  try {
    const result: SavedReplyMutation = await updateSavedReply(
      accessToken,
      replyId,
      shortcut,
      body
    );
    if (result.kind === "ok") {
      return safeJson({ ok: true, reply: result.reply ?? null }, 200);
    }
    if (result.kind === "duplicate") {
      return safeJson(
        {
          error: {
            code: "duplicate",
            message: "A reply with this shortcut already exists.",
          },
        },
        409
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Saved reply not found." } },
        404
      );
    }
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Use letters, numbers, dashes or underscores for the shortcut.",
        },
      },
      400
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
