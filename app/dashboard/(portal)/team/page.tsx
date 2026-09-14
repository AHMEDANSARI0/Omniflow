import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listTeam,
  requirePortalAccessToken,
  type TeamMember,
} from "../../../../lib/omniflow/portal";
import TeamClient from "./TeamClient";


export default async function TeamPage() {
  const session = await getOmniFlowSession();

  let initialMembers: TeamMember[] | null = null;
  let initialRole: string | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const overview = await listTeam(accessToken);
      if (overview) {
        initialMembers = overview.members;
        initialRole = overview.myRole;
      }
    }
  }

  return <TeamClient initialMembers={initialMembers} initialRole={initialRole} />;
}
