import { getSocialChannels } from "../../../../../../lib/omniflow/portal";
import { noStoreHeaders } from "../../../../../../lib/omniflow/request-security";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getSocialChannels(accessToken))
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
