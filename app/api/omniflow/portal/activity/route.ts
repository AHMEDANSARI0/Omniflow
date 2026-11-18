import { neonEnabled, neonQuery } from "../../../../../lib/db/neon";
import { requireOmniFlowPrincipal } from "../../../../../lib/omniflow/auth-dal";
import { listAccessAuditLogs } from "../../../../../lib/omniflow/entitlements";
import { getTenantHybridConfig } from "../../../../../lib/omniflow/hybrid-whatsapp-engine";
import {
  getRecentActivity,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

interface PortalActivityItem {
  id: number;
  action: string;
  label: string;
  note: string;
  conversationId: number | null;
  createdAt: string;
  timeAgo: string;
}

function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return "just now";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "just now";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export async function GET() {
  let clientId = 1;
  try {
    const principal = await requireOmniFlowPrincipal();
    clientId = principal.clientId;
  } catch {
    const accessToken = await requirePortalAccessToken();
    if (!accessToken) {
      return safeJson(
        { error: { code: "unauthorized", message: "Sign in required." } },
        401
      );
    }
  }

  const items: PortalActivityItem[] = [];
  let nextId = 1000;

  // 1. Try Control Plane activity if available
  try {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const remoteItems = await getRecentActivity(accessToken);
      if (Array.isArray(remoteItems) && remoteItems.length > 0) {
        for (const r of remoteItems) {
          items.push({
            id: Number(r.id || nextId++),
            action: String(r.action || "conversation"),
            label: String(r.label || "Workspace activity"),
            note: String(r.note || ""),
            conversationId:
              typeof r.conversationId === "number" ? r.conversationId : null,
            createdAt: String(r.createdAt || new Date().toISOString()),
            timeAgo: String(r.timeAgo || fmtTimeAgo(r.createdAt)),
          });
        }
      }
    }
  } catch {
    // Fallback to local & Neon workspace activity below
  }

  // 2. Include real conversations from Neon DB (portal_conversations)
  if (neonEnabled()) {
    try {
      const res = await neonQuery<{
        id: number;
        channel: string | null;
        contact_id: string;
        contact_name: string | null;
        status: string | null;
        last_message_at: string | null;
        last_message_preview: string | null;
      }>(
        `SELECT id, channel, contact_id, contact_name, status, last_message_at, last_message_preview
         FROM portal_conversations
         WHERE client_id = $1
         ORDER BY COALESCE(last_message_at, created_at) DESC
         LIMIT 15`,
        [clientId]
      );
      for (const c of res.rows) {
        const createdAt = c.last_message_at || new Date().toISOString();
        items.push({
          id: nextId++,
          action: "conversation.message",
          label: `WhatsApp chat with ${c.contact_name || c.contact_id || "Customer"}`,
          note: c.last_message_preview
            ? `Latest: "${c.last_message_preview}" (${(c.status || "open").toUpperCase()})`
            : `Conversation status: ${(c.status || "open").toUpperCase()}`,
          conversationId: Number(c.id),
          createdAt,
          timeAgo: fmtTimeAgo(createdAt),
        });

        if (c.contact_id) {
          items.push({
            id: nextId++,
            action: "customers.synced",
            label: `Customer contact synced: ${c.contact_name || c.contact_id}`,
            note: `Channel: ${c.channel || "whatsapp"} · Contact ID: ${c.contact_id}`,
            conversationId: Number(c.id),
            createdAt,
            timeAgo: fmtTimeAgo(createdAt),
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Include Hybrid WhatsApp Engine stats & rule status
  try {
    const hybrid = await getTenantHybridConfig(clientId);
    const nowIso = new Date().toISOString();
    if (hybrid.stats.ruleReplies > 0 || hybrid.stats.aiReplies > 0) {
      items.push({
        id: nextId++,
        action: "bot.hybrid_execution",
        label: `Hybrid WhatsApp Automation processed ${hybrid.stats.received} message(s)`,
        note: `${hybrid.stats.ruleReplies} Rule reply · ${hybrid.stats.aiReplies} AI reply · ${hybrid.stats.humanHandovers} Handovers`,
        conversationId: null,
        createdAt: nowIso,
        timeAgo: "recent",
      });
    }
    const activeRules = hybrid.rules.filter((r) => r.enabled);
    items.push({
      id: nextId++,
      action: "bot.rules_active",
      label: `Hybrid Automation Engine active for ${hybrid.businessConfig.businessName}`,
      note: `${activeRules.length} deterministic rules enabled · Language mode: ${hybrid.businessConfig.preferredLanguage.toUpperCase()}`,
      conversationId: null,
      createdAt: nowIso,
      timeAgo: "active",
    });
  } catch {
    // ignore
  }

  // 4. Include Platform Access & Configuration Audit Logs for this workspace
  try {
    const logs = await listAccessAuditLogs(clientId, 10);
    for (const log of logs) {
      items.push({
        id: nextId++,
        action: "bot." + log.action,
        label: `Workspace configuration updated (${log.action.replace(/_/g, " ")})`,
        note: `${log.targetKey} updated by ${log.adminEmail}`,
        conversationId: null,
        createdAt: log.createdAt,
        timeAgo: fmtTimeAgo(log.createdAt),
      });
    }
  } catch {
    // ignore
  }

  return safeJson({ items }, 200);
}
