import { redirect } from "next/navigation";
import { getSalesOverview, getSalesSettings, requirePortalAccessToken } from "../../../../lib/omniflow/portal";
import SalesDeskClient from "./SalesDeskClient";

export const dynamic = "force-dynamic";

export default async function SalesDeskPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");
  const [settings, overview] = await Promise.all([getSalesSettings(accessToken), getSalesOverview(accessToken)]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Sales desk</h1>
        <p className="mt-1 text-sm text-ink-2">
          Which chats are close to buying, what customers worry about, and the
          approved answers your assistant and team use. Quotes are created from a
          chat and priced from your catalog.
        </p>
      </div>
      <SalesDeskClient
        initialSettings={settings.kind === "ok" ? settings.data : null}
        initialOverview={overview.kind === "ok" ? overview.data : null}
      />
    </div>
  );
}
