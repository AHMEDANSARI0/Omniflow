import {
  createConfigSnapshot,
  listConfigSnapshots,
} from "../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../lib/omniflow/voice-vision-bff";

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await listConfigSnapshots(accessToken))
  );
}

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const label = typeof body.label === "string" ? body.label.slice(0, 120) : "";
    return serviceResponse(await createConfigSnapshot(accessToken, label));
  }, request);
}
