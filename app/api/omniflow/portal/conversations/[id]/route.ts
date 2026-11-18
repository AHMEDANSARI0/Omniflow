import { neonEnabled, neonQuery } from "../../../../../../lib/db/neon";
import { getOmniFlowSession } from "../../../../../../lib/omniflow/auth-dal";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getConversation,
  requirePortalAccessToken,
  type ConversationMessage,
  type ConversationSummary,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function getNeonConversationFallback(
  conversationId: number,
  clientId?: number
): Promise<{
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  has_more: boolean;
} | null> {
  if (!neonEnabled()) return null;
  try {
    const convRes = await neonQuery<{
      id: number | string;
      client_id: number | string;
      channel: string | null;
      contact_id: string | null;
      contact_name: string | null;
      status: string | null;
      last_message_preview: string | null;
      last_message_at: string | null;
      created_at: string | null;
    }>(
      clientId
        ? `SELECT id, client_id, channel, contact_id, contact_name, status, last_message_preview, last_message_at, created_at
           FROM portal_conversations
           WHERE id = $1 AND client_id = $2
           LIMIT 1`
        : `SELECT id, client_id, channel, contact_id, contact_name, status, last_message_preview, last_message_at, created_at
           FROM portal_conversations
           WHERE id = $1
           LIMIT 1`,
      clientId ? [conversationId, clientId] : [conversationId]
    );
    const row = convRes.rows[0];
    if (!row) return null;

    const msgRes = await neonQuery<{
      id: number | string;
      direction: string | null;
      body: string | null;
      status: string | null;
      created_at: string | null;
    }>(
      `SELECT id, direction, body, status, created_at
       FROM portal_messages
       WHERE conversation_id = $1
       ORDER BY id ASC
       LIMIT 200`,
      [conversationId]
    ).catch(() => null);

    const messages: ConversationMessage[] = (msgRes?.rows || []).map((m) => ({
      id: Number(m.id) || 0,
      direction: m.direction === "out" ? "out" : "in",
      body: String(m.body || ""),
      status: String(m.status || "delivered"),
      intent: null,
      createdAt: m.created_at ? new Date(m.created_at).toISOString() : null,
    }));

    // If no rows in portal_messages yet but last_message_preview exists on conversation, synthesize initial bubble
    if (messages.length === 0 && row.last_message_preview) {
      messages.push({
        id: 1,
        direction: "in",
        body: String(row.last_message_preview),
        status: "received",
        intent: null,
        createdAt: row.last_message_at
          ? new Date(row.last_message_at).toISOString()
          : row.created_at
            ? new Date(row.created_at).toISOString()
            : new Date().toISOString(),
      });
    }

    const conversation: ConversationSummary = {
      id: Number(row.id) || conversationId,
      channel: row.channel || "whatsapp",
      contactId: row.contact_id || null,
      contactName: row.contact_name || row.contact_id || `Conversation #${conversationId}`,
      status: row.status || "open",
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      lastMessagePreview: row.last_message_preview || null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      unread: false,
      needsReply: false,
      vip: false,
      paidOrders: 0,
      lastIntent: null,
      leadScore: 0,
      leadTemp: "warm",
      assignedTo: null,
      assigneeName: null,
      starred: false,
      tags: [],
    };

    return {
      conversation,
      messages,
      has_more: false,
    };
  } catch {
    return null;
  }
}

export async function GET(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const conversationId = Number.parseInt(id, 10);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const result = await getConversation(accessToken, conversationId);
      if (result.kind === "ok") {
        return safeJson(
          {
            conversation: result.conversation,
            messages: result.messages,
            has_more: result.hasMore,
          },
          200
        );
      }
    } catch (error) {
      if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
        return safeJson(
          { error: { code: "unauthorized", message: "Session expired." } },
          401
        );
      }
    }
  }

  // Fallback to Neon PostgreSQL portal_conversations + portal_messages
  const session = await getOmniFlowSession().catch(() => null);
  const clientId = session?.kind === "authenticated" ? session.principal.clientId : undefined;
  const fallback =
    (await getNeonConversationFallback(conversationId, clientId)) ||
    (await getNeonConversationFallback(conversationId));

  if (fallback) {
    return safeJson(fallback, 200);
  }

  return safeJson(
    {
      conversation: {
        id: conversationId,
        channel: "whatsapp",
        contactId: null,
        contactName: `Conversation #${conversationId}`,
        status: "open",
        lastMessageAt: null,
        lastMessagePreview: null,
        createdAt: null,
        unread: false,
        needsReply: false,
        vip: false,
        paidOrders: 0,
        lastIntent: null,
        leadScore: 0,
        leadTemp: "warm",
        assignedTo: null,
        assigneeName: null,
        starred: false,
        tags: [],
      },
      messages: [],
      has_more: false,
    },
    200
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
