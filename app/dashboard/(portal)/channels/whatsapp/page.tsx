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

  const hasSocialConnectors = Boolean(
    entitlements.features["workspace.instagram_connector"]?.enabled ||
      entitlements.features["workspace.facebook_connector"]?.enabled ||
      entitlements.features["workspace.messenger_connector"]?.enabled ||
      entitlements.connectors["instagram"]?.enabled ||
      entitlements.connectors["facebook"]?.enabled ||
      entitlements.connectors["messenger"]?.enabled
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {hasSocialConnectors && (
        <div className="flex justify-end">
          <Link
            href="/dashboard/channels"
            className="rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs font-medium text-ink-2 shadow-sm hover:bg-soft hover:text-ink"
          >
            All Workspace Channels →
          </Link>
        </div>
      )}

      <SocialConnectorsHub initialPlatform="whatsapp" />
    </div>
  );
}
