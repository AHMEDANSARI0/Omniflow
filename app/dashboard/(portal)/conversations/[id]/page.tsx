import { getOmniFlowSession } from "../../../../../lib/omniflow/auth-dal";
import {
  getConversation,
  requirePortalAccessToken,
  type ConversationMessage,
  type ConversationSummary,
} from "../../../../../lib/omniflow/portal";
import ThreadClient from "./ThreadClient";


export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getOmniFlowSession();

  let initialConversation: ConversationSummary | null = null;
  let initialMessages: ConversationMessage[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    const conversationId = Number.parseInt(id, 10);
    if (accessToken && Number.isFinite(conversationId)) {
      const detail = await getConversation(accessToken, conversationId);
      if (detail.kind === "ok") {
        initialConversation = detail.conversation;
        initialMessages = detail.messages;
      }
    }
  }

  return (
    <ThreadClient
      conversationId={id}
      initialConversation={initialConversation}
      initialMessages={initialMessages}
    />
  );
}
