import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listWorkflows,
  requirePortalAccessToken,
  type PortalWorkflow,
} from "../../../../lib/omniflow/portal";
import WorkflowsClient from "./WorkflowsClient";

export default async function WorkflowsPage() {
  const session = await getOmniFlowSession();

  let initialWorkflows: PortalWorkflow[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      try {
        initialWorkflows = await listWorkflows(accessToken);
      } catch {
        initialWorkflows = null;
      }
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <WorkflowsClient initialWorkflows={initialWorkflows} />
    </div>
  );
}
