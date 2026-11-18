import { redirect } from "next/navigation";
import { getOmniFlowSession } from "../../../lib/omniflow/auth-dal";
import { resolveTenantEntitlements } from "../../../lib/omniflow/entitlements";
import ControlPlaneUnavailable from "../components/ControlPlaneUnavailable";
import DashShell from "../components/DashShell";
import SessionKeeper from "../components/SessionKeeper";

export default async function DashboardPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getOmniFlowSession();

  if (session.kind === "unauthenticated") redirect("/dashboard/login");
  if (session.kind === "refresh_required") redirect("/dashboard/reauth");
  if (session.kind === "unavailable") return <ControlPlaneUnavailable />;

  const entitlements = await resolveTenantEntitlements(
    session.principal.clientId,
    session.principal.role || "owner"
  );

  const enabledFeatures = Object.values(entitlements.features)
    .filter((f) => f.enabled)
    .map((f) => f.featureKey);

  return (
    <DashShell
      userEmail={session.principal.email}
      clientId={session.principal.clientId}
      role={session.principal.role}
      planName={entitlements.planName}
      workspaceStatus={entitlements.workspaceStatus}
      enabledFeatures={enabledFeatures}
    >
      <SessionKeeper />
      {children}
    </DashShell>
  );
}
