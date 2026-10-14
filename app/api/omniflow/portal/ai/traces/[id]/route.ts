import { getAiTrace } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import { serviceResponse, withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

/** One AI answer, step by step (§241): message, guard, agent, tools, model, decision, reply. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id ?? "") || !Number(id)) {
    return safeJson({ error: { code: "bad_request", message: "Trace id must be a positive whole number." } }, 400);
  }
  return withPortalToken(async (accessToken) => serviceResponse(await getAiTrace(accessToken, Number(id))));
}
