import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendInteractiveTemplate,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


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
  const conversationId = Number(input.conversation_id);
  const templateId = Number(input.template_id);
  if (!Number.isInteger(conversationId) || conversationId < 1
    || !Number.isInteger(templateId) || templateId < 1) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "conversation_id and template_id are required.",
        },
      },
      400
    );
  }

  try {
    const result = await sendInteractiveTemplate(
      accessToken,
      conversationId,
      templateId
    );
    if (result === "not_found") {
      return safeJson(
        {
          error: { code: "not_found", message: "Conversation or template not found." },
        },
        404
      );
    }
    if (result === "bad_request") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "This chat has no WhatsApp contact id.",
          },
        },
        400
      );
    }
    if (result === null || !result.ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, kind: result.kind }, 200);
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
