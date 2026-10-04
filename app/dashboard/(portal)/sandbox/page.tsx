import { redirect } from "next/navigation";
import { requirePortalAccessToken } from "../../../../lib/omniflow/portal";
import SandboxClient from "./SandboxClient";

export const dynamic = "force-dynamic";

export default async function SandboxPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">AI Sandbox</h1>
        <p className="mt-1 text-sm text-ink-2">
          Type a customer message and see exactly what your setup would do: the
          reply, the AI&apos;s reasoning, tags, handoffs, approvals and workflow
          steps. Save the messages that matter as tests and re-run them after
          every change.
        </p>
      </div>
      <SandboxClient />
    </div>
  );
}
