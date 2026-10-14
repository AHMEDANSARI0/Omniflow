import { getSalesOverview } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** Hot leads + which concerns come up and how often those chats still buy. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getSalesOverview(accessToken)));
}
