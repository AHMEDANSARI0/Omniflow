import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listBroadcasts,
  requirePortalAccessToken,
  type BroadcastRow,
} from "../../../../lib/omniflow/portal";
import BroadcastsClient from "./BroadcastsClient";
import CopyGenCard from "./CopyGenCard";


export default async function BroadcastsPage() {
  const session = await getOmniFlowSession();

  let initialHistory: BroadcastRow[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const result = await listBroadcasts(accessToken);
      if (result) initialHistory = result.broadcasts;
    }
  }

  return (
    <div className="space-y-4">
      <CopyGenCard />
      <BroadcastsClient initialHistory={initialHistory} />
    </div>
  );
}
