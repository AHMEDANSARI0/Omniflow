import { getLoyaltyCustomer } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** One customer's tier, progress, due message and last retention send. */
export async function GET(request: Request) {
  const contactId = (new URL(request.url).searchParams.get("contact_id") || "").trim();
  if (!contactId || contactId.length > 100) {
    return safeJson({ error: { code: "bad_request", message: "contact_id is required." } }, 400);
  }
  return withPortalToken(async (accessToken) => serviceResponse(await getLoyaltyCustomer(accessToken, contactId)));
}
