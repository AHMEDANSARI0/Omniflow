import Link from "next/link";
import SocialConnectorsHub from "../../../../components/portal/SocialConnectorsHub";
import { requireOmniFlowPrincipal } from "../../../../../lib/omniflow/auth-dal";
import { resolveTenantEntitlements } from "../../../../../lib/omniflow/entitlements";

export const dynamic = "force-dynamic";

export default async function WhatsAppChannelPage() {
  const principal = await requireOmniFlowPrincipal();
  const entitlements = await resolveTenantEntitlements(
    principal.clientId,
    principal.role || "owner"
  );

  const canUseWati = Boolean(
    entitlements.features["workspace.multi_whatsapp"]?.enabled ||
      entitlements.features["marketing.broadcasts"]?.enabled ||
      entitlements.connectors["whatsapp_multi"]?.enabled
  );
  const hasSocialConnectors = Boolean(
    entitlements.features["workspace.instagram_connector"]?.enabled ||
      entitlements.features["workspace.facebook_connector"]?.enabled ||
      entitlements.features["workspace.messenger_connector"]?.enabled ||
      entitlements.connectors["instagram"]?.enabled ||
      entitlements.connectors["facebook"]?.enabled ||
      entitlements.connectors["messenger"]?.enabled
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white px-5 py-4 shadow-card">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-brand">
            WhatsApp Channel
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-ink">
            {canUseWati
              ? "WhatsApp Connector & WATI Templates"
              : "WhatsApp Connector Setup"}
          </h1>
          <p className="mt-0.5 text-xs text-ink-2">
            {canUseWati
              ? "Monitor your live WhatsApp connector session, queue connect or disconnect commands, and manage approved WATI templates."
              : "Monitor your live WhatsApp connector session, link your WhatsApp number via QR or Pairing Code, and manage connection commands."}
          </p>
        </div>
        {hasSocialConnectors && (
          <Link
            href="/dashboard/channels"
            className="rounded-xl border border-line bg-soft px-3.5 py-2 text-xs font-medium text-ink-2 hover:bg-line/50 hover:text-ink"
          >
            All Workspace Channels →
          </Link>
        )}
      </div>

      <SocialConnectorsHub initialPlatform="whatsapp" />
    </div>
  );
}
