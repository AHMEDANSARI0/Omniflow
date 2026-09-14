import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listBroadcasts,
  requirePortalAccessToken,
  type BroadcastRow,
} from "../../../../lib/omniflow/portal";
import BroadcastsClient from "./BroadcastsClient";


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

  return <BroadcastsClient initialHistory={initialHistory} />;
}
