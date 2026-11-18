import { neonEnabled, neonQuery } from "../../../../../lib/db/neon";
import {
  ControlPlaneRequestError,
  getControlPlanePrincipal,
} from "../../../../../lib/omniflow/control-plane";
import {
  listCustomers,
  requirePortalAccessToken,
  type CustomerSummary,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const channel = (url.searchParams.get("channel") || "all")
    .trim()
    .toLowerCase();

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const customers = await listCustomers(
        accessToken,
        query || undefined,
        channel !== "all" ? channel : undefined
      );

      if (customers !== null) {
        return safeJson({ customers }, 200);
      }
    } catch (error) {
      if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
        return safeJson(
          { error: { code: "unauthorized", message: "Sign in required." } },
          401
        );
      }
    }
  }

  if (neonEnabled()) {
    try {
      const principal = await getControlPlanePrincipal(accessToken);
      const res = await neonQuery<{
        channel: string | null;
        contact_id: string;
        contact_name: string | null;
        status: string | null;
        last_message_preview: string | null;
        last_message_at: string | null;
      }>(
        `SELECT channel, contact_id, contact_name, status, last_message_preview, last_message_at
         FROM portal_conversations
         WHERE client_id = $1
         ORDER BY last_message_at DESC NULLS LAST, id DESC
         LIMIT 50`,
        [principal.clientId]
      );
      const customers: CustomerSummary[] = res.rows.map((r) => ({
        contactId: r.contact_id,
        name: r.contact_name || "",
        channels: [r.channel || "whatsapp"],
        conversationCount: 1,
        openCount: (r.status || "open") === "open" ? 1 : 0,
        lastMessageAt: r.last_message_at
          ? new Date(r.last_message_at).toISOString()
          : null,
        lastMessagePreview: r.last_message_preview,
        leadTemp: "cold",
        tags: [],
      }));
      return safeJson({ customers }, 200);
    } catch {
      // fall through
    }
  }

  return safeJson({ customers: [] }, 200);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
