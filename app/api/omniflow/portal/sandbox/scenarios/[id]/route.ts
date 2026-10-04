import {
  deleteSandboxScenario,
  updateSandboxScenario,
} from "../../../../../../../lib/omniflow/portal";
import { sandboxScenarioInput } from "../../../../../../../lib/omniflow/sandbox-input";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

type Context = { params: Promise<{ id: string }> };

const notFound = () =>
  safeJson({ error: { code: "not_found", message: "No such saved test." } }, 404);

export async function PUT(request: Request, context: Context) {
  const scenarioId = Number((await context.params).id);
  if (!Number.isSafeInteger(scenarioId) || scenarioId <= 0) return notFound();
  return withPortalToken(async (accessToken) => {
    const input = sandboxScenarioInput(await jsonBody(request));
    if (!input) {
      return safeJson(
        { error: { code: "bad_request", message: "Give the test a name and a customer message." } },
        400
      );
    }
    return serviceResponse(await updateSandboxScenario(accessToken, scenarioId, input));
  }, request);
}

export async function DELETE(request: Request, context: Context) {
  const scenarioId = Number((await context.params).id);
  if (!Number.isSafeInteger(scenarioId) || scenarioId <= 0) return notFound();
  return withPortalToken(async (accessToken) =>
    serviceResponse(await deleteSandboxScenario(accessToken, scenarioId)), request);
}
