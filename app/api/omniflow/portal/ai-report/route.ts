import { validateAdminToken, requireAdmin } from "../../../../lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "../../../../lib/rate-limit/limiter";
import { getLogger } from "../../../../lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { getAiReport } from "../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../lib/omniflow/voice-vision-bff";

/** A check reads the whole AI setup (a few seconds at most). */
export const maxDuration = 30;

export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getAiReport(accessToken, fresh))
  );
}
