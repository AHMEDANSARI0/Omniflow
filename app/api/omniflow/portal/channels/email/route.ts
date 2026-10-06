import { getEmailChannel, saveEmailChannel } from "../../../../../../lib/omniflow/portal";
import type { EmailChannelInput } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

function bad(message: string) {
  return safeJson({ error: { code: "bad_request", message } }, 400);
}

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" && value.length <= max ? value.trim() : null;
}

function port(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const num = typeof value === "string" && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof num === "number" && Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null;
}

/** §243 email channel: mailbox settings (the password is never returned). */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getEmailChannel(accessToken)));
}

/** Owners / admins only; the Control Plane validates hosts and turns the channel on only after a passing test. */
export async function PUT(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const address = text(body.address, 254);
    const displayName = text(body.display_name, 80);
    const username = text(body.username, 200);
    const imapHost = text(body.imap_host, 253);
    const smtpHost = text(body.smtp_host, 253);
    const password = body.password === undefined || body.password === null ? "" : body.password;
    if (address === null || displayName === null || username === null || imapHost === null || smtpHost === null) {
      return bad("Mailbox fields must be text.");
    }
    if (typeof password !== "string" || password.length > 500) return bad("The password must be text.");
    const imapPort = port(body.imap_port, 993);
    const smtpPort = port(body.smtp_port, 465);
    if (imapPort === null || smtpPort === null) return bad("Ports must be numbers from 1 to 65535.");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return bad("enabled must be true or false.");
    const input: EmailChannelInput = {
      address,
      display_name: displayName,
      username,
      password,
      imap_host: imapHost,
      imap_port: imapPort,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      enabled: body.enabled === true,
    };
    return serviceResponse(await saveEmailChannel(accessToken, input));
  }, request);
}
