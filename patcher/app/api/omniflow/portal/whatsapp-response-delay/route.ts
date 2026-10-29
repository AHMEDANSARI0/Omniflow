import { safeJson } from "../../../../../lib/omniflow/request-security";
import { requirePortalAccessToken } from "../../../../../lib/omniflow/portal";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");

  if (!clientId || isNaN(Number(clientId))) {
    return safeJson({ error: "Invalid client_id" }, 400);
  }

  // Returns response delay for a specific client.
  // The delay is stored in BotConfig.responseDelaySeconds per client.
  // Admin sets this from the CP portal bot settings page.
  const perClientEnv = process.env[`WHATSAPP_RESPONSE_DELAY_${clientId}`];
  const globalEnv = process.env.OMNIFLOW_WHATSAPP_RESPONSE_DELAY_SECONDS;

  const delay = perClientEnv || globalEnv || "0";

  return safeJson({
    responseDelaySeconds: Number(delay),
    client_id: Number(clientId),
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
