import { redirect } from "next/navigation";
import { getOmniFlowSession } from "../../../lib/omniflow/auth-dal";
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

  return (
    <DashShell
      userEmail={session.principal.email}
      clientId={session.principal.clientId}
      role={session.principal.role}
    >
      <SessionKeeper />
      {children}
    </DashShell>
  );
}
