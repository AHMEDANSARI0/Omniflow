import { validateAdminToken, requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/limiter";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { createSandboxScenario } from "../../../../../../lib/omniflow/portal";
import { sandboxScenarioInput } from "../../../../../../lib/omniflow/sandbox-input";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const input = sandboxScenarioInput(await jsonBody(request));
    if (!input) {
      return safeJson(
        { error: { code: "bad_request", message: "Give the test a name and a customer message." } },
        400
      );
    }
    return serviceResponse(await createSandboxScenario(accessToken, input));
  }, request);
}
