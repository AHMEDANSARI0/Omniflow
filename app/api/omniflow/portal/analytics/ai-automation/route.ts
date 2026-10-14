import { getAiAutomation } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** AI + automation quadrant for the Analytics page (read-only). */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("days") ?? "30";
  if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 90) {
    return safeJson(
      { error: { code: "bad_request", message: "days must be a whole number from 1 to 90." } },
      400
    );
  }
  return withPortalToken(async (accessToken) => serviceResponse(await getAiAutomation(accessToken, Number(raw))));
}
