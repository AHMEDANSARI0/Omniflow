import { getLoyaltyOverview } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** Tiers, who is due a message (and who is held back), results. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getLoyaltyOverview(accessToken)));
}
