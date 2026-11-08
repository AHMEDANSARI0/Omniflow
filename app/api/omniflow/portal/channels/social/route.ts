import { validateAdminToken, requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/limiter";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { getSocialChannels } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** §255 social channels: every channel's mode, connection, switches, limits and recent posts. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getSocialChannels(accessToken)));
}
