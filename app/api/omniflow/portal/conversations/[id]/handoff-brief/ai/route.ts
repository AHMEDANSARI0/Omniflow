import { validateAdminToken, requireAdmin } from "../../../../lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "../../../../lib/rate-limit/limiter";
import { getLogger } from "../../../../lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { requestAiHandoffBrief } from "../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";
import { serviceResponse, withPortalToken } from "../../../../../../../../lib/omniflow/voice-vision-bff";

/** One model call, capped at 20 s on the server. */
export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number.parseInt((await params).id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Invalid conversation id." } }, 400);
  }
  return withPortalToken(
    async (accessToken) => serviceResponse(await requestAiHandoffBrief(accessToken, id)),
    request
  );
}
