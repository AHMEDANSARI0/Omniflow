import { unpinAnalyticsQuestion } from "../../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withPortalToken(async (accessToken) => {
    const { id } = await params;
    if (!/^[1-9][0-9]{0,17}$/.test(id)) {
      return safeJson(
        { error: { code: "bad_request", message: "Unknown pinned question." } },
        400
      );
    }
    return serviceResponse(await unpinAnalyticsQuestion(accessToken, Number(id)));
  }, request);
}
