import { checkRuleConflictsWithAi } from "../../../../../../../lib/omniflow/portal";
import { serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** One AI call over the overlapping answer pairs. */
export const maxDuration = 60;

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await checkRuleConflictsWithAi(accessToken)), request);
}
