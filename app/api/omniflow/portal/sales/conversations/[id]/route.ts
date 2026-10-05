import { getSalesLead } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** The lead card for one chat: details, concerns, quote choices. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number.parseInt((await params).id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Invalid conversation id." } }, 400);
  }
  return withPortalToken(async (accessToken) => serviceResponse(await getSalesLead(accessToken, id)));
}
