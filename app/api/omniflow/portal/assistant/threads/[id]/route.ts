import {
  deleteAssistantThread,
  getAssistantThread,
} from "../../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

type Context = { params: Promise<{ id: string }> };

const notFound = () =>
  safeJson({ error: { code: "not_found", message: "Conversation not found." } }, 404);

export async function GET(_request: Request, context: Context) {
  const threadId = Number((await context.params).id);
  if (!Number.isSafeInteger(threadId) || threadId <= 0) return notFound();
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getAssistantThread(accessToken, threadId))
  );
}

export async function DELETE(request: Request, context: Context) {
  const threadId = Number((await context.params).id);
  if (!Number.isSafeInteger(threadId) || threadId <= 0) return notFound();
  return withPortalToken(async (accessToken) =>
    serviceResponse(await deleteAssistantThread(accessToken, threadId)), request);
}
