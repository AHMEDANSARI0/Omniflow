import type { Metadata } from "next";

import BrainCard from "../settings/BrainCard";
import { getBotConfig, getFollowupSettings } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import BotForm from "./BotForm";
import FollowupSettingsForm from "./FollowupSettingsForm";


export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Configure AI" };

export default async function MyBotPage() {
  const { accessToken } = await readSessionCookies();
  const config = accessToken ? await getBotConfig(accessToken) : null;
  const followupSettings = accessToken
    ? await getFollowupSettings(accessToken)
    : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Configure AI
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Everything about how the assistant talks and takes decisions:
          behaviour, follow-ups, and the autonomy level that decides whether
          it only suggests, drafts, or answers on its own. Business details
          (products, prices, policies, FAQs) live in Business profile.
        </p>
      </div>

      <BotForm
        initial={config}
        backendConfigured={config?.configured ?? false}
      />

      <div className="mt-6">
        <FollowupSettingsForm initial={followupSettings} />
      </div>

      <div className="mt-6">
        <BrainCard />
      </div>
    </div>
  );
}
