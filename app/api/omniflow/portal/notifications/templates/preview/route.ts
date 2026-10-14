import { previewNotifyTemplate } from "../../../../../../../lib/omniflow/portal";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** Render a draft template with sample values (nothing is saved or sent). */
export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const kind = typeof body.kind === "string" && /^[a-z_]{1,40}$/.test(body.kind) ? body.kind : "system";
    const subject = typeof body.subject === "string" ? body.subject.slice(0, 400) : "";
    const text = typeof body.body === "string" ? body.body.slice(0, 4000) : "";
    return serviceResponse(await previewNotifyTemplate(accessToken, kind, subject, text));
  }, request);
}
