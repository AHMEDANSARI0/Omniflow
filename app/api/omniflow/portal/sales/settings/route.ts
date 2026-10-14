import { getSalesSettings, saveSalesSettings } from "../../../../../../lib/omniflow/portal";
import type { SalesQualifier } from "../../../../../../lib/omniflow/portal";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

/** §237 sales settings + the approved-answer playbook. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getSalesSettings(accessToken)));
}

/** Owners / admins only (the Control Plane enforces it); known keys only. */
export async function PUT(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    return serviceResponse(
      await saveSalesSettings(accessToken, {
        autoStage: typeof body.autoStage === "boolean" ? body.autoStage : undefined,
        brainContext: typeof body.brainContext === "boolean" ? body.brainContext : undefined,
        qualifiers: Array.isArray(body.qualifiers)
          ? body.qualifiers.filter((item): item is SalesQualifier => typeof item === "string").slice(0, 6)
          : undefined,
      })
    );
  }, request);
}
