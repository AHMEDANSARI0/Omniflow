import { validateAdminToken, requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/limiter";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { runLoyaltyMessages } from "../../../../../../lib/omniflow/portal";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** Preview (default) or send due messages now - owners / admins only. */
export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    return serviceResponse(await runLoyaltyMessages(accessToken, body.dryRun !== false));
  }, request);
}
