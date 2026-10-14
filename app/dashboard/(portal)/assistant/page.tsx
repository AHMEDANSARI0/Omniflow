import { redirect } from "next/navigation";
import { requirePortalAccessToken } from "../../../../lib/omniflow/portal";
import AssistantClient from "./AssistantClient";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Ask OmniFlow AI</h1>
        <p className="mt-1 text-sm text-ink-2">
          Ask about your business in plain words, or ask for a change. Small
          setup changes are applied with an undo; anything bigger waits for your
          confirmation, and refunds or cancellations still go through approvals.
        </p>
      </div>
      <AssistantClient />
    </div>
  );
}
