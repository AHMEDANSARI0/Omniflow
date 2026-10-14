import { listConversationMedia } from "../../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

/** §214: files the customer sent in this conversation (media store). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const conversationId = Number.parseInt(id, 10);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Bad conversation id." } },
      400
    );
  }
  return withPortalToken(async (token) =>
    serviceResponse(await listConversationMedia(token, conversationId))
  );
}
