import { setRuleConflictIgnored } from "../../../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const id = typeof body.id === "string" ? body.id : "";
    if (!/^[0-9a-f]{16}$/.test(id) || typeof body.ignored !== "boolean") {
      return safeJson(
        { error: { code: "bad_request", message: "Send the finding id and ignored true or false." } },
        400
      );
    }
    return serviceResponse(await setRuleConflictIgnored(accessToken, id, body.ignored));
  }, request);
}
