import { summarizeAiReport } from "../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** Fresh check + one model call (capped at 20 s on the server). */
export const maxDuration = 30;

export async function POST(request: Request) {
  return withPortalToken(
    async (accessToken) => serviceResponse(await summarizeAiReport(accessToken)),
    request
  );
}
