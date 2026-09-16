import {
  createConversationAction,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";

const KINDS = ["cancel_order", "change_address", "refund_request"];


export async function POST(
  request: Request,
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
  const conversationId = Number.parseInt(id, 10);
  if (!Number.isFinite(conversationId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const kind = input.kind;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (typeof kind !== "string" || !KINDS.includes(kind)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Pick cancel_order, change_address or refund_request.",
        },
      },
      400
    );
  }
  if (note.length > 300) {
    return safeJson(
      { error: { code: "bad_request", message: "Note must be 300 characters or fewer." } },
      400
    );
  }

  try {
    const result = await createConversationAction(
      accessToken,
      conversationId,
      kind,
      note
    );
    if (result.kind === "ok") {
      return safeJson({ ok: true, id: result.id, kind, status: "pending" }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
        404
      );
    }
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Pick cancel_order, change_address or refund_request.",
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
