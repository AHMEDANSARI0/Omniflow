import { runSandbox } from "../../../../../../lib/omniflow/portal";
import { sandboxInput } from "../../../../../../lib/omniflow/sandbox-input";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

/** One run is a real pass of the automations, AI calls included. */
export const maxDuration = 60;

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const input = sandboxInput(await jsonBody(request));
    if (!input) {
      return safeJson(
        { error: { code: "bad_request", message: "Type the customer's message (max 2000 characters)." } },
        400
      );
    }
    return serviceResponse(await runSandbox(accessToken, input));
  }, request);
}
