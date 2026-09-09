import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteSavedReply,
  requirePortalAccessToken,
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
