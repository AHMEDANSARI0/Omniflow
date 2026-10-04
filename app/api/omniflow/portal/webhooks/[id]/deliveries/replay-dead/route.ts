import { replayDeadWebhookDeliveries } from "../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../../lib/omniflow/voice-vision-bff";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return safeJson(
      { error: { code: "not_found", message: "Webhook not found." } },
      404
    );
  }
  return withPortalToken(async (accessToken) => {
    return serviceResponse(await replayDeadWebhookDeliveries(accessToken, id));
  }, request);
}
