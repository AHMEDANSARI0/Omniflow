import { listAiTraces } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

const KINDS = ["ingest_answer", "voice_answer", "draft"];
const DECISIONS = ["send", "handoff"];

function bad(message: string) {
  return safeJson({ error: { code: "bad_request", message } }, 400);
}

/** AI execution traces (§241): one summary per AI answer, newest first. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const days = params.get("days") ?? "7";
  if (!/^\d{1,2}$/.test(days) || Number(days) < 1 || Number(days) > 90) {
    return bad("days must be a whole number from 1 to 90.");
  }
  const kind = params.get("kind") ?? "";
  if (kind && !KINDS.includes(kind)) return bad("Unknown kind.");
  const decision = params.get("decision") ?? "";
  if (decision && !DECISIONS.includes(decision)) return bad("decision must be send or handoff.");
  const ids: Record<string, number> = {};
  for (const name of ["agent_id", "conversation_id"]) {
    const raw = params.get(name) ?? "";
    if (!raw) continue;
    if (!/^\d{1,18}$/.test(raw) || !Number(raw)) return bad(name + " must be a positive whole number.");
    ids[name] = Number(raw);
  }
  const limit = params.get("limit") ?? "50";
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1) return bad("limit must be a whole number from 1 to 100.");
  return withPortalToken(async (accessToken) =>
    serviceResponse(
      await listAiTraces(accessToken, {
        days: Number(days),
        kind,
        decision,
        agentId: ids.agent_id,
        conversationId: ids.conversation_id,
        limit: Math.min(Number(limit), 100),
      })
    )
  );
}
