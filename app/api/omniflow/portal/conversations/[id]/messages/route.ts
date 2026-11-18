import { neonEnabled, neonQuery } from "../../../../../../../lib/db/neon";
import { getOmniFlowSession } from "../../../../../../../lib/omniflow/auth-dal";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  getConversationMessages,
  requirePortalAccessToken,
  sendConversationMessage,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const beforeRaw = new URL(request.url).searchParams.get("before_id") || "";
  const beforeId = Number(beforeRaw);
  if (beforeRaw && (!Number.isInteger(beforeId) || beforeId <= 0)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid before_id." } },
      400
    );
  }

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const result = await getConversationMessages(accessToken, conversationId, beforeId);
      if (result.kind === "ok") {
        return safeJson({ messages: result.messages, has_more: result.hasMore }, 200);
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

  if (neonEnabled()) {
    try {
      const res = await neonQuery<{
        id: number | string;
        direction: string | null;
        body: string | null;
        status: string | null;
        created_at: string | null;
      }>(
        beforeId > 0
          ? `SELECT id, direction, body, status, created_at
             FROM portal_messages
             WHERE conversation_id = $1 AND id < $2
             ORDER BY id ASC
             LIMIT 100`
          : `SELECT id, direction, body, status, created_at
             FROM portal_messages
             WHERE conversation_id = $1
             ORDER BY id ASC
             LIMIT 100`,
        beforeId > 0 ? [conversationId, beforeId] : [conversationId]
      );
      return safeJson(
        {
          messages: (res.rows || []).map((m) => ({
            id: Number(m.id) || 0,
            direction: m.direction === "out" ? "out" : "in",
            body: String(m.body || ""),
            status: String(m.status || "delivered"),
            intent: null,
            createdAt: m.created_at ? new Date(m.created_at).toISOString() : null,
          })),
          has_more: false,
        },
        200
      );
    } catch {
      // fall through
    }
  }

  return safeJson({ messages: [], has_more: false }, 200);
}

export async function POST(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    body?: unknown;
  } | null;
  const body = payload && typeof payload.body === "string" ? payload.body : "";
  if (!body.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Message body is required." } },
      400
    );
  }

  const cleanBody = body.trim().slice(0, 4096);

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const result = await sendConversationMessage(
        accessToken,
        conversationId,
        cleanBody
      );
      if (result.kind === "ok") {
        return safeJson(
          { ok: true, queued: result.queued, command_id: result.commandId },
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

  if (neonEnabled()) {
    try {
      const session = await getOmniFlowSession().catch(() => null);
      const clientId =
        session?.kind === "authenticated" ? session.principal.clientId : 1;

      const convRes = await neonQuery<{
        id: number | string;
        client_id: number | string;
        contact_id: string | null;
        contact_name: string | null;
      }>(
        `SELECT id, client_id, contact_id, contact_name
         FROM portal_conversations
         WHERE id = $1
         LIMIT 1`,
        [conversationId]
      );
      const conv = convRes.rows[0];
      const effectiveClientId = conv ? Number(conv.client_id) || clientId : clientId;

      await neonQuery(
        `INSERT INTO portal_messages (conversation_id, client_id, direction, body, status, created_at)
         VALUES ($1, $2, 'out', $3, 'queued', NOW())`,
        [conversationId, effectiveClientId, cleanBody]
      );

      await neonQuery(
        `UPDATE portal_conversations
         SET last_message_preview = $1, last_message_at = NOW()
         WHERE id = $2`,
        [cleanBody.slice(0, 240), conversationId]
      );

      const cmdRes = await neonQuery<{ id: number | string }>(
        `INSERT INTO portal_connector_commands
         (client_id, channel, action, payload, status, created_at, updated_at)
         VALUES ($1, 'whatsapp', 'send_message', $2::jsonb, 'pending', NOW(), NOW())
         RETURNING id`,
        [
          effectiveClientId,
          JSON.stringify({
            conversation_id: conversationId,
            contact_id: conv?.contact_id || "",
            contact_name: conv?.contact_name || "",
            body: cleanBody,
          }),
        ]
      );
      return safeJson(
        {
          ok: true,
          queued: true,
          command_id: Number(cmdRes.rows[0]?.id || 0),
        },
        200
      );
    } catch {
      // fall through
    }
  }

  return safeJson(
    { error: { code: "portal_unavailable", message: "Try again shortly." } },
    503
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
