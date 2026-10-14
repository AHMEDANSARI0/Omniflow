import { cancelSiteScan } from "../../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const scanId = Number((await context.params).id);
  if (!Number.isSafeInteger(scanId) || scanId <= 0) {
    return safeJson({ error: { code: "not_found", message: "Scan not found." } }, 404);
  }
  return withPortalToken(async (accessToken) =>
    serviceResponse(await cancelSiteScan(accessToken, scanId)), request);
}
