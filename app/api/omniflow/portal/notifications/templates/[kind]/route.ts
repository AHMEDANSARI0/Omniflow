import { resetNotifyTemplate, saveNotifyTemplate } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

type Context = { params: Promise<{ kind: string }> };

const BAD_KIND = { error: { code: "bad_request", message: "Unknown notification kind." } };

function validKind(kind: string): boolean {
  return /^[a-z_]{1,40}$/.test(kind);
}

/** Save one kind's email template (owners / admins). */
export async function PUT(request: Request, context: Context) {
  const { kind } = await context.params;
  return withPortalToken(async (accessToken) => {
    if (!validKind(kind)) return safeJson(BAD_KIND, 400);
    const body = await jsonBody(request);
    const subject = typeof body.subject === "string" ? body.subject.slice(0, 400) : "";
    const text = typeof body.body === "string" ? body.body.slice(0, 4000) : "";
    return serviceResponse(await saveNotifyTemplate(accessToken, kind, subject, text));
  }, request);
}

/** Back to the built-in email for this kind. */
export async function DELETE(request: Request, context: Context) {
  const { kind } = await context.params;
  return withPortalToken(async (accessToken) => {
    if (!validKind(kind)) return safeJson(BAD_KIND, 400);
    return serviceResponse(await resetNotifyTemplate(accessToken, kind));
  }, request);
}
