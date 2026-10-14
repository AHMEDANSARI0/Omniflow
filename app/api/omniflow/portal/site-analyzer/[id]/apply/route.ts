import { applySiteScan } from "../../../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

const strings = (value: unknown, cap: number) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").slice(0, cap)
    : [];
const ints = (value: unknown, cap: number) =>
  Array.isArray(value)
    ? value.filter((v): v is number => Number.isSafeInteger(v) && v >= 0).slice(0, cap)
    : [];

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const scanId = Number((await context.params).id);
  if (!Number.isSafeInteger(scanId) || scanId <= 0) {
    return safeJson({ error: { code: "not_found", message: "Scan not found." } }, 404);
  }
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    return serviceResponse(
      await applySiteScan(accessToken, scanId, {
        facts: strings(body.facts, 30),
        profile: strings(body.profile, 10),
        kbPages: ints(body.kbPages, 100),
        faqSource: body.faqSource === true,
        products: ints(body.products, 250),
      })
    );
  }, request);
}
