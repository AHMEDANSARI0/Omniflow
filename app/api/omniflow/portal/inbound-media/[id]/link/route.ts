import { getInboundMediaLink } from "../../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

/** §214: provider link for a video / file (refreshed for Instagram). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const mediaId = Number.parseInt(id, 10);
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Bad file id." } }, 400);
  }
  return withPortalToken(async (token) =>
    serviceResponse(await getInboundMediaLink(token, mediaId))
  );
}
