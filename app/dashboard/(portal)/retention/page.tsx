import { redirect } from "next/navigation";
import { getLoyaltyOverview, getLoyaltySettings, requirePortalAccessToken } from "../../../../lib/omniflow/portal";
import RetentionClient from "./RetentionClient";

export const dynamic = "force-dynamic";

export default async function RetentionPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");
  const [settings, overview] = await Promise.all([getLoyaltySettings(accessToken), getLoyaltyOverview(accessToken)]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Retention</h1>
        <p className="mt-1 text-sm text-ink-2">
          Loyalty tiers for your buyers, a reward offer per tier, and timed reorder and win-back messages. Automatic
          messages are off until you switch them on.
        </p>
      </div>
      <RetentionClient
        initialSettings={settings.kind === "ok" ? settings.data : null}
        initialOverview={overview.kind === "ok" ? overview.data : null}
      />
    </div>
  );
}
