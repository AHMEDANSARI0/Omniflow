import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  assignConversation,
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
    assigneeEmail?: unknown;
  } | null;
  let assigneeEmail: string | null = null;
  if (typeof payload?.assigneeEmail === "string" && payload.assigneeEmail.trim()) {
    assigneeEmail = payload.assigneeEmail.trim().toLowerCase();
    if (assigneeEmail.length > 120) {
      return safeJson(
        { error: { code: "bad_request", message: "Invalid assignee email." } },
        400
      );
    }
  }

  try {
    const result = await assignConversation(accessToken, conversationId, assigneeEmail);
    if (result.kind === "ok") {
      return safeJson(
        {
          ok: true,
          assigned_to: result.assignedTo,
          assignee_name: result.assigneeName,
        },
        200
      );
    }
    if (result.kind === "assignee_not_found") {
      return safeJson(
        {
          error: {
            code: "assignee_not_found",
            message: "That teammate is not an active member.",
          },
        },
        404
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
        404
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
