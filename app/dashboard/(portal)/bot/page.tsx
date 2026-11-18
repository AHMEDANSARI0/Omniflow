import type { Metadata } from "next";

import { requireOmniFlowPrincipal } from "../../../../lib/omniflow/auth-dal";
import { resolveTenantEntitlements } from "../../../../lib/omniflow/entitlements";
import { getBotConfig, getFollowupSettings } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import BrainCard from "../settings/BrainCard";
import FactsCard from "../settings/FactsCard";
import AiOpsCard from "./AiOpsCard";
import AiQualityCard from "./AiQualityCard";
import BotForm from "./BotForm";
import EscalationsCard from "./EscalationsCard";
import FollowupSettingsForm from "./FollowupSettingsForm";
import HybridWhatsAppCard from "./HybridWhatsAppCard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Configure AI" };

export default async function MyBotPage() {
  const principal = await requireOmniFlowPrincipal();
  const { accessToken } = await readSessionCookies();
  const entitlements = await resolveTenantEntitlements(
    principal.clientId,
    principal.role || "owner"
  );
  const hasAdvancedAi = Boolean(entitlements.features["ai.advanced_config"]?.enabled);

  const config =
    accessToken && hasAdvancedAi ? await getBotConfig(accessToken) : null;
  const followupSettings =
    accessToken && hasAdvancedAi ? await getFollowupSettings(accessToken) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Configure AI Assistant
        </h1>
        <p className="mt-1 text-sm text-ink-2">
          Manage your AI assistant&apos;s response language (Urdu, Roman Urdu, English), conversation tone, system guardrails, and human handover triggers.
        </p>
      </div>

      <div className="mb-6">
        <HybridWhatsAppCard mode="ai" />
      </div>

      {hasAdvancedAi && (
        <>
          <BotForm
            initial={config}
            backendConfigured={config?.configured ?? false}
          />

          <div className="mt-6">
            <FactsCard />
          </div>

          <div className="mt-6">
            <EscalationsCard />
          </div>

          <div className="mt-6">
            <FollowupSettingsForm initial={followupSettings} />
          </div>

          <div className="mt-6">
            <BrainCard />
          </div>

          <div className="mt-6">
            <AiOpsCard />
          </div>

          <div className="mt-6">
            <AiQualityCard />
          </div>
        </>
      )}
    </div>
  );
}
