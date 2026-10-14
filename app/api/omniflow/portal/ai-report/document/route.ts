import { getAiSetupDocument } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

export const maxDuration = 30;

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getAiSetupDocument(accessToken))
  );
}
