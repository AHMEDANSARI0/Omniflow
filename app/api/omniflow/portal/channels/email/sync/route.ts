import { syncEmailChannel } from "../../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** "Check now": sends queued email replies and imports new mail. */
export const maxDuration = 30;

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => serviceResponse(await syncEmailChannel(accessToken)), request);
}
