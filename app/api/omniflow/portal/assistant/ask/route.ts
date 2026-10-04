import { askAssistant } from "../../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

/** One question may run several model calls and lookups. */
export const maxDuration = 60;

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 2000) {
      return safeJson(
        { error: { code: "bad_request", message: "Type a question (max 2000 characters)." } },
        400
      );
    }
    const threadId =
      typeof body.threadId === "number" && Number.isSafeInteger(body.threadId) && body.threadId > 0
        ? body.threadId
        : null;
    return serviceResponse(await askAssistant(accessToken, message, threadId));
  }, request);
}
