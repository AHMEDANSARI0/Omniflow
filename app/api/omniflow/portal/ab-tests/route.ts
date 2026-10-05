import { listAbTests, startAbTest } from "../../../../../lib/omniflow/portal";
import { abInputFromBody } from "../../../../../lib/omniflow/ab-test-input";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../lib/omniflow/request-security";

/** Starting a test queues up to 200 sends. */
export const maxDuration = 30;

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await listAbTests(accessToken))
  );
}

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const input = abInputFromBody(body);
    if (typeof input === "string") {
      return safeJson({ error: { code: "bad_request", message: input } }, 400);
    }
    return serviceResponse(await startAbTest(accessToken, input, body.dryRun === true));
  }, request);
}
