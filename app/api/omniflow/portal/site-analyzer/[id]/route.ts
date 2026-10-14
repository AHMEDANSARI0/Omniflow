import { deleteSiteScan, getSiteScan } from "../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

type Context = { params: Promise<{ id: string }> };

const notFound = () =>
  safeJson({ error: { code: "not_found", message: "Scan not found." } }, 404);

export async function GET(_request: Request, context: Context) {
  const scanId = Number((await context.params).id);
  if (!Number.isSafeInteger(scanId) || scanId <= 0) return notFound();
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getSiteScan(accessToken, scanId))
  );
}

export async function DELETE(request: Request, context: Context) {
  const scanId = Number((await context.params).id);
  if (!Number.isSafeInteger(scanId) || scanId <= 0) return notFound();
  return withPortalToken(async (accessToken) =>
    serviceResponse(await deleteSiteScan(accessToken, scanId)), request);
}
