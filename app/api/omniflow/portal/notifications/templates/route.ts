import { validateAdminToken, requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/limiter";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { getNotifyTemplates } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** §239 email templates per notification kind + defaults + variables. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getNotifyTemplates(accessToken)));
}
