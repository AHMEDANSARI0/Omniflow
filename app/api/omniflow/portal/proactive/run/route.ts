import { runProactiveCheck } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** §242 "Check now": runs every enabled rule over recent customer messages. */
export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => serviceResponse(await runProactiveCheck(accessToken)), request);
}
