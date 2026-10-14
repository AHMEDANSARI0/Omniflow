import { redirect } from "next/navigation";
import { requirePortalAccessToken } from "../../../../lib/omniflow/portal";
import WebsiteAnalyzerClient from "./WebsiteAnalyzerClient";

export const dynamic = "force-dynamic";

export default async function WebsiteAnalyzerPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Website analyzer</h1>
        <p className="mt-1 text-sm text-ink-2">
          Reads your public website the way a customer would: contact details,
          delivery, returns, payments, products and FAQs. You choose what goes
          into your assistant. Nothing changes until you apply it.
        </p>
      </div>
      <WebsiteAnalyzerClient />
    </div>
  );
}
