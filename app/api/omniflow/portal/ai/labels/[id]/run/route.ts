import { ControlPlaneRequestError } from "../../../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  runAiLabelSet,
} from "../../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = {
  error: { code: "portal_unavailable", message: "Try again shortly." },
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const { id } = await params;
  const setId = Number.parseInt(id ?? "", 10);
  if (!Number.isFinite(setId) || setId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }
  const body = (await request.json().catch(() => null)) as {
    include_live?: unknown;
  } | null;
  const includeLive = body?.include_live === true;

  try {
    const payload = await runAiLabelSet(accessToken, setId, includeLive);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(
      {
        set_id: payload.setId,
        name: payload.name,
        mode: payload.mode,
        llm_calls: payload.llmCalls,
        passed: payload.passed,
        total: payload.total,
        score: payload.score,
        status: payload.status,
        results: payload.results.map((r) => ({
          message: r.message,
          expected_decision: r.expectedDecision,
          actual_decision: r.actualDecision,
          passed: r.passed,
          detail: r.detail,
          live_reply: r.liveReply,
        })),
      },
      200
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
