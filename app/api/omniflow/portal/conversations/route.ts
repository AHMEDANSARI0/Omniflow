import { neonEnabled, neonQuery } from "../../../../../lib/db/neon";
import {
  ControlPlaneRequestError,
  getControlPlanePrincipal,
} from "../../../../../lib/omniflow/control-plane";
import {
  listConversations,
  requirePortalAccessToken,
  type ConversationSummary,
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
  const status = (url.searchParams.get("status") || "all").trim();
  const intent = (url.searchParams.get("intent") || "all").trim();
  const channel = (url.searchParams.get("channel") || "all").trim().toLowerCase();
  const tag = (url.searchParams.get("tag") || "all").trim().slice(0, 32);
  const needsReply = (url.searchParams.get("needs_reply") || "").trim();
  const sort = (url.searchParams.get("sort") || "newest").trim();
  const assigned = (url.searchParams.get("assigned") || "all").trim();
  const includeCounts = url.searchParams.get("counts") === "1";
  const limitRaw = Number(url.searchParams.get("limit") || "0");
  const limit = limitRaw >= 1 && limitRaw <= 50 ? Math.floor(limitRaw) : undefined;
  const days = (url.searchParams.get("days") || "").trim();
  const unread = url.searchParams.get("unread") === "1" ? "1" : "";
  const starred = url.searchParams.get("starred") === "1" ? "1" : "";
  const pageRaw = Number(url.searchParams.get("page") || "1");
  const page = pageRaw >= 2 && pageRaw <= 100 ? Math.floor(pageRaw) : undefined;

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const result = await listConversations(
        accessToken,
        query || undefined,
        status,
        intent,
        channel,
        tag,
        needsReply || undefined,
        sort,
        assigned,
        includeCounts,
        limit,
        days || undefined,
        unread || undefined,
        starred || undefined,
        page
      );

      if (result !== null) {
        return safeJson(
          {
            conversations: result.conversations,
            counts: result.counts,
          },
          200
        );
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
        id: number;
        channel: string | null;
        contact_id: string;
        contact_name: string | null;
        status: string | null;
        last_message_preview: string | null;
        last_message_at: string | null;
        created_at: string | null;
      }>(
        `SELECT id, channel, contact_id, contact_name, status, last_message_preview, last_message_at, created_at
         FROM portal_conversations
         WHERE client_id = $1
         ORDER BY last_message_at DESC NULLS LAST, id DESC
         LIMIT $2`,
        [principal.clientId, limit || 50]
      );
      const conversations: ConversationSummary[] = res.rows.map((r) => ({
        id: Number(r.id),
        channel: r.channel || "whatsapp",
        contactId: r.contact_id,
        contactName: r.contact_name,
        status: r.status || "open",
        lastMessagePreview: r.last_message_preview,
        lastMessageAt: r.last_message_at
          ? new Date(r.last_message_at).toISOString()
          : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        unread: false,
        needsReply: (r.status || "open") === "open",
        vip: false,
        paidOrders: 0,
        lastIntent: null,
        leadScore: 0,
        leadTemp: "cold",
        assignedTo: null,
        assigneeName: null,
        starred: false,
        tags: [],
      }));
      return safeJson(
        {
          conversations,
          counts: {
            needsReply: conversations.filter((c) => c.needsReply).length,
            overdue: 0,
            unassigned: conversations.length,
            unread: 0,
          },
        },
        200
      );
    } catch {
      // fall through
    }
  }

  return safeJson(
    {
      conversations: [],
      counts: { needsReply: 0, overdue: 0, unassigned: 0, unread: 0 },
    },
    200
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
