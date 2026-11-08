import { validateAdminToken, requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/limiter";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { testEmailChannel } from "../../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** Signs in to IMAP and SMTP (nothing is sent); passing turns the channel on. */
export const maxDuration = 30;

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => serviceResponse(await testEmailChannel(accessToken)), request);
}
