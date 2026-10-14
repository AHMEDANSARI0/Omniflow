import { generateWorkflow, getWorkflowGenerator } from "../../../../../../lib/omniflow/portal";
import { workflowGenInput } from "../../../../../../lib/omniflow/workflow-gen-input";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

/** One or two AI calls (a draft plus at most one repair round). */
export const maxDuration = 60;

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getWorkflowGenerator(accessToken))
  );
}

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const parsed = workflowGenInput(await jsonBody(request));
    if (!parsed.ok) {
      return safeJson({ error: { code: "bad_request", message: parsed.message } }, 400);
    }
    return serviceResponse(await generateWorkflow(accessToken, parsed.input));
  }, request);
}
