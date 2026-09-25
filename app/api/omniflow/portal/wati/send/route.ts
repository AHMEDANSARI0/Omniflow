import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendWatiTemplate,
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
  const templateName =
    typeof input.template_name === "string" ? input.template_name.trim() : "";
  const params = Array.isArray(input.parameters)
    ? (input.parameters as unknown[])
    : [];
  if (!Number.isInteger(conversationId) || conversationId < 1
    || !templateName) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "conversation_id aur template_name zaroori hain.",
        },
      },
      400
    );
  }
  const values = params
    .map((item) =>
      typeof item === "string"
        ? item
        : item !== null && typeof item === "object"
          && typeof (item as Record<string, unknown>).value === "string"
          ? ((item as Record<string, unknown>).value as string)
          : "")
    .filter((value) => value.trim() !== "");

  try {
    const result = await sendWatiTemplate(
      accessToken,
      conversationId,
      templateName,
      values
    );
    if (result === "not_found") {
      return safeJson(
        {
          error: {
            code: "not_found",
            message: "Conversation ya approved template nahi mila - sync karein.",
          },
        },
        404
      );
    }
    if (result === "bad_request") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Pehle Settings me WATI enable karein.",
          },
        },
        400
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, template: templateName }, 200);
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
