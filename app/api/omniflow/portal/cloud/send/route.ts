import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendCloudTemplate,
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
  const conversationId =
    typeof input.conversation_id === "number" ? input.conversation_id : 0;
  const templateName =
    typeof input.template_name === "string" ? input.template_name.trim() : "";
  const languageCode =
    typeof input.language_code === "string" && input.language_code.trim()
      ? input.language_code.trim()
      : "en";
  const parameters = Array.isArray(input.parameters)
    ? input.parameters
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  if (!conversationId || !templateName) {
    return safeJson(
      {
        error: { code: "bad_request", message: "Pick a template first." },
      },
      400
    );
  }

  try {
    const result = await sendCloudTemplate(accessToken, {
      conversationId,
      templateName,
      languageCode,
      parameters,
    });
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "This chat has no WhatsApp contact id." } },
        400
      );
    }
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
        404
      );
    }
    return safeJson({ ok: true, template: result.template }, 200);
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
