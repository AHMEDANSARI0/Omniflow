import { neonEnabled, neonQuery } from "../../../../lib/db/neon";
import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listConversations,
  requirePortalAccessToken,
  type ConversationChipCounts,
  type ConversationSummary,
} from "../../../../lib/omniflow/portal";
import InboxClient from "./InboxClient";

async function loadNeonConversations(
  clientId: number,
  query: string
): Promise<{
  conversations: ConversationSummary[];
  counts: ConversationChipCounts;
} | null> {
  if (!neonEnabled()) return null;
  try {
    const q = query.trim();
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
      q
        ? `SELECT id, channel, contact_id, contact_name, status, last_message_preview, last_message_at, created_at
           FROM portal_conversations
           WHERE client_id = $1
             AND (contact_id ILIKE $2 OR COALESCE(contact_name, '') ILIKE $2 OR COALESCE(last_message_preview, '') ILIKE $2)
           ORDER BY last_message_at DESC NULLS LAST, id DESC
           LIMIT 50`
        : `SELECT id, channel, contact_id, contact_name, status, last_message_preview, last_message_at, created_at
           FROM portal_conversations
           WHERE client_id = $1
           ORDER BY last_message_at DESC NULLS LAST, id DESC
           LIMIT 50`,
      q ? [clientId, `%${q}%`] : [clientId]
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

    return {
      conversations,
      counts: {
        needsReply: conversations.filter((c) => c.needsReply).length,
        overdue: 0,
        unassigned: conversations.length,
        unread: 0,
      },
    };
  } catch {
    return null;
  }
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOmniFlowSession();
  const params = await searchParams;
  const rawQuery = params.q;
  const query = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";

  let initialItems: ConversationSummary[] | null = null;
  let initialCounts: ConversationChipCounts | null = null;
  if (session.kind === "authenticated") {
    try {
      const accessToken = await requirePortalAccessToken();
      if (accessToken && !accessToken.startsWith("ofa_neon_")) {
        const result = await listConversations(accessToken, query || undefined);
        if (result) {
          initialItems = result.conversations;
          initialCounts = result.counts;
        }
      }
    } catch {
      // Fall back to direct Neon query below
    }

    if (initialItems === null) {
      const neonData = await loadNeonConversations(
        session.principal.clientId,
        query
      );
      if (neonData) {
        initialItems = neonData.conversations;
        initialCounts = neonData.counts;
      } else {
        initialItems = [];
        initialCounts = { needsReply: 0, overdue: 0, unassigned: 0, unread: 0 };
      }
    }
  }

  return <InboxClient initialItems={initialItems} initialCounts={initialCounts} />;
}
