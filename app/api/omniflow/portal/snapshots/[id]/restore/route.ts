import { restoreConfigSnapshot } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid snapshot id." } },
      400
    );
  }
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const areas = Array.isArray(body.areas)
      ? body.areas.filter((item): item is string => typeof item === "string")
      : null;
    return serviceResponse(
      // an empty list goes through: the Control Plane refuses it (400)
      // rather than turning a bad request into a full restore
      await restoreConfigSnapshot(accessToken, id, areas)
    );
  }, request);
}
