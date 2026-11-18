import { redirect } from "next/navigation";
import { requireOmniFlowPrincipal } from "../../../../lib/omniflow/auth-dal";
import { resolveTenantEntitlements } from "../../../../lib/omniflow/entitlements";
import {
  getApiKeyInfo,
  requirePortalAccessToken,
} from "../../../../lib/omniflow/portal";
import ActionRunsCard from "./ActionRunsCard";
import ApiKeyCard from "./ApiKeyCard";
import BiThresholdsCard from "./BiThresholdsCard";
import BrandsCard from "./BrandsCard";
import BusinessHoursCard from "./BusinessHoursCard";
import CatalogCard from "./CatalogCard";
import ConfigHistoryCard from "./ConfigHistoryCard";
import CouponsCard from "./CouponsCard";
import DataSafetyCard from "./DataSafetyCard";
import DeliveriesCard from "./DeliveriesCard";
import EmailChannelCard from "./EmailChannelCard";
import InstagramCard from "./InstagramCard";
import NegotiationCard from "./NegotiationCard";
import NotificationsCard from "./NotificationsCard";
import NotificationTemplatesCard from "./NotificationTemplatesCard";
import PaymentsCard from "./PaymentsCard";
import PerfCard from "./PerfCard";
import ProactiveAlertsCard from "./ProactiveAlertsCard";
import SmsChannelCard from "./SmsChannelCard";
import SocialChannelsCard from "./SocialChannelsCard";
import VoiceVisionCard from "./VoiceVisionCard";
import WatiCard from "./WatiCard";
import WeeklyProblemsCard from "./WeeklyProblemsCard";
import WidgetSettingsCard from "./WidgetSettingsCard";

export const dynamic = "force-dynamic";

export default async function ClientSettingsPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");

  const principal = await requireOmniFlowPrincipal();
  const entitlements = await resolveTenantEntitlements(
    principal.clientId,
    principal.role || "owner"
  );
  const f = entitlements.features;
  const c = entitlements.connectors;

  const hasExternalApi = Boolean(f["workspace.external_api"]?.enabled && c.external_api?.enabled);
  const hasMultiWa = Boolean(f["workspace.multi_whatsapp"]?.enabled && c.whatsapp_multi?.enabled);
  const hasMeta = Boolean(
    (f["workspace.instagram_connector"]?.enabled && c.instagram?.enabled) ||
      (f["workspace.facebook_connector"]?.enabled && c.facebook?.enabled) ||
      (f["workspace.messenger_connector"]?.enabled && c.messenger?.enabled)
  );
  const hasSales = Boolean(f["sales.sales_desk"]?.enabled);
  const hasGrowth = Boolean(f["marketing.growth"]?.enabled);
  const hasInsights = Boolean(f["insights.business_insights"]?.enabled);
  const hasWeekly = Boolean(f["insights.weekly_reports"]?.enabled);
  const hasCompliance = Boolean(f["workspace.compliance"]?.enabled);
  const hasCustomRules = Boolean(f["automation.custom_rules"]?.enabled);
  const hasMedia = Boolean(f["content.media"]?.enabled);
  const hasAdvancedActivity = Boolean(f["insights.advanced_activity"]?.enabled);

  let keyInfo: {
    key_prefix: string;
    revoked: boolean;
    created_at: string;
    last_used_at: string | null;
  } | null = null;

  if (hasExternalApi) {
    try {
      const info = await getApiKeyInfo(accessToken);
      if (info.configured) {
        keyInfo = {
          key_prefix: info.keyPrefix ?? "ofk_",
          revoked: info.revoked,
          created_at: info.createdAt ?? "",
          last_used_at: info.lastUsedAt,
        };
      }
    } catch {
      keyInfo = null;
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Settings
        </h1>
        <p className="mt-1 text-sm text-ink-2">
          Business hours, notifications, and authorized workspace integrations.
        </p>
      </div>

      <BusinessHoursCard />
      <NotificationsCard />
      <NotificationTemplatesCard />

      {hasExternalApi && <ApiKeyCard keyInfo={keyInfo} />}
      {hasMultiWa && <WatiCard />}
      {hasMeta && <InstagramCard />}
      {hasMeta && <SocialChannelsCard />}
      {hasExternalApi && <EmailChannelCard />}
      {hasExternalApi && <SmsChannelCard />}

      {hasGrowth && (
        <div className="mt-6">
          <WidgetSettingsCard />
        </div>
      )}
      {hasMedia && (
        <div className="mt-6">
          <VoiceVisionCard />
        </div>
      )}
      {hasSales && (
        <>
          <PaymentsCard />
          <CatalogCard />
          <CouponsCard />
          <DeliveriesCard />
        </>
      )}
      {hasCustomRules && <NegotiationCard />}
      {hasInsights && (
        <>
          <BiThresholdsCard />
          <ProactiveAlertsCard />
        </>
      )}
      {hasWeekly && <WeeklyProblemsCard />}
      {hasCompliance && (
        <>
          <DataSafetyCard />
          <ConfigHistoryCard />
        </>
      )}
      {hasAdvancedActivity && (
        <>
          <ActionRunsCard />
          <PerfCard />
          <BrandsCard />
        </>
      )}
    </div>
  );
}
