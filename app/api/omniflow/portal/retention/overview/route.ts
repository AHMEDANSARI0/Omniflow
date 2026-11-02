import { validateAdminToken, requireAdmin } from "../../../../lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "../../../../lib/rate-limit/limiter";
import { getLogger } from "../../../../lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { getLoyaltyOverview } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** Tiers, who is due a message (and who is held back), results. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getLoyaltyOverview(accessToken)));
}
