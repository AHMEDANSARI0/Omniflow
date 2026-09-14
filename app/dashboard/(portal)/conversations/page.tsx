import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listConversations,
  requirePortalAccessToken,
  type ConversationChipCounts,
  type ConversationSummary,
} from "../../../../lib/omniflow/portal";
import InboxClient from "./InboxClient";


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
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const result = await listConversations(accessToken, query || undefined);
      if (result) {
        initialItems = result.conversations;
        initialCounts = result.counts;
      }
    }
  }

  return <InboxClient initialItems={initialItems} initialCounts={initialCounts} />;
}
