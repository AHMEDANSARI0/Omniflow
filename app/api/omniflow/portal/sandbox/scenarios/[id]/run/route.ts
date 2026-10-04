import { runSandboxScenario } from "../../../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";

/** One run is a real pass of the automations, AI calls included. */
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const scenarioId = Number((await context.params).id);
  if (!Number.isSafeInteger(scenarioId) || scenarioId <= 0) {
    return safeJson({ error: { code: "not_found", message: "No such saved test." } }, 404);
  }
  return withPortalToken(async (accessToken) =>
    serviceResponse(await runSandboxScenario(accessToken, scenarioId)), request);
}
