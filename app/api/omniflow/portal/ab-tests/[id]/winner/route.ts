import { chooseAbWinner } from "../../../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

/** Sending the winner queues up to 200 sends. */
export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withPortalToken(async (accessToken) => {
    const { id } = await params;
    const body = await jsonBody(request);
    const variant = typeof body.variant === "string" ? body.variant.trim().toUpperCase() : "";
    if (!/^[1-9][0-9]{0,17}$/.test(id) || !/^[A-D]$/.test(variant)) {
      return safeJson(
        { error: { code: "bad_request", message: "Pick one of the test's versions." } },
        400
      );
    }
    return serviceResponse(await chooseAbWinner(accessToken, Number(id), variant));
  }, request);
}
