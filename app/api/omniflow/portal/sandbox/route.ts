import { getSandbox } from "../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../lib/omniflow/voice-vision-bff";

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getSandbox(accessToken))
  );
}
