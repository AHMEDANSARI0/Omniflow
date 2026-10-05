import { getHandoffBrief } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** §236: the deterministic handoff brief (a few small reads). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number.parseInt((await params).id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Invalid conversation id." } }, 400);
  }
  return withPortalToken(async (accessToken) => serviceResponse(await getHandoffBrief(accessToken, id)));
}
