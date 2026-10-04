import { listSiteScans, startSiteScan } from "../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../lib/omniflow/request-security";

/** Starting a scan runs its first crawl step. */
export const maxDuration = 60;

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await listSiteScans(accessToken))
  );
}

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const url = typeof body.url === "string" ? body.url.trim().slice(0, 500) : "";
    if (!url) {
      return safeJson(
        { error: { code: "bad_request", message: "Enter your website address." } },
        400
      );
    }
    const maxPages = typeof body.maxPages === "number" ? Math.trunc(body.maxPages) : 0;
    return serviceResponse(await startSiteScan(accessToken, url, maxPages));
  }, request);
}
