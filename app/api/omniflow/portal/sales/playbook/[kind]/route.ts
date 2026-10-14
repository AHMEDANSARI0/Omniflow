import { saveSalesPlaybook } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** Save the owner's approved answer for one customer concern. */
export async function PUT(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const kind = (await params).kind;
  if (!/^[a-z_]{2,30}$/.test(kind)) {
    return safeJson({ error: { code: "bad_request", message: "Unknown concern." } }, 400);
  }
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const reply = typeof body.reply === "string" ? body.reply.slice(0, 2000) : "";
    return serviceResponse(await saveSalesPlaybook(accessToken, kind, reply, body.enabled !== false));
  }, request);
}
