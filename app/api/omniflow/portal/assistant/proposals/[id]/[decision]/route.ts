import {
  decideAssistantProposal,
  type AssistantDecision,
} from "../../../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";

type Context = { params: Promise<{ id: string; decision: string }> };

const DECISIONS: AssistantDecision[] = ["confirm", "reject", "undo"];

export async function POST(request: Request, context: Context) {
  const { id, decision } = await context.params;
  const proposalId = Number(id);
  const chosen = DECISIONS.find((d) => d === decision);
  if (!Number.isSafeInteger(proposalId) || proposalId <= 0 || !chosen) {
    return safeJson({ error: { code: "not_found", message: "Change not found." } }, 404);
  }
  return withPortalToken(async (accessToken) =>
    serviceResponse(await decideAssistantProposal(accessToken, proposalId, chosen)), request);
}
