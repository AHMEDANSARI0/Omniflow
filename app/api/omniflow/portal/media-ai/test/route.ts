import { testMediaAi } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

/** Owner check: what the assistant would read for one Media-library file. */
export async function POST(request: Request) {
  return withPortalToken(async (token) => {
    const body = await jsonBody(request);
    const assetId = Math.trunc(Number(body.asset_id || 0));
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return safeJson(
        { error: { code: "bad_request", message: "Choose a file from the Media library." } },
        400
      );
    }
    return serviceResponse(await testMediaAi(token, assetId));
  }, request);
}
