import { neonEnabled, neonQuery } from "../../../../lib/db/neon";
import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listCustomers,
  requirePortalAccessToken,
  type CustomerSummary,
} from "../../../../lib/omniflow/portal";
import CustomersClient from "./CustomersClient";

async function loadNeonCustomers(
  clientId: number,
  query: string
): Promise<CustomerSummary[] | null> {
  if (!neonEnabled()) return null;
  try {
    const q = query.trim();
    const res = await neonQuery<{
      channel: string | null;
      contact_id: string;
      contact_name: string | null;
      status: string | null;
      last_message_preview: string | null;
      last_message_at: string | null;
    }>(
      q
        ? `SELECT channel, contact_id, contact_name, status, last_message_preview, last_message_at
           FROM portal_conversations
           WHERE client_id = $1
             AND (contact_id ILIKE $2 OR COALESCE(contact_name, '') ILIKE $2)
           ORDER BY last_message_at DESC NULLS LAST, id DESC
           LIMIT 50`
        : `SELECT channel, contact_id, contact_name, status, last_message_preview, last_message_at
           FROM portal_conversations
           WHERE client_id = $1
           ORDER BY last_message_at DESC NULLS LAST, id DESC
           LIMIT 50`,
      q ? [clientId, `%${q}%`] : [clientId]
    );
    return res.rows.map((r) => ({
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
  } catch {
    return null;
  }
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOmniFlowSession();
  const params = await searchParams;
  const rawQuery = params.q;
  const query = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";

  let initialCustomers: CustomerSummary[] | null = null;
  if (session.kind === "authenticated") {
    try {
      const accessToken = await requirePortalAccessToken();
      if (accessToken && !accessToken.startsWith("ofa_neon_")) {
        initialCustomers = await listCustomers(accessToken, query || undefined);
      }
    } catch {
      initialCustomers = null;
    }

    if (initialCustomers === null) {
      initialCustomers =
        (await loadNeonCustomers(session.principal.clientId, query)) ?? [];
    }
  }

  return <CustomersClient initialCustomers={initialCustomers} initialQuery={query} />;
}
