import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  getAiQualitySample,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = {
  error: { code: "portal_unavailable", message: "Try again shortly." },
};

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const daysRaw = Number.parseInt(
    new URL(request.url).searchParams.get("days") ?? "7",
    10
  );
  const days = [1, 7, 14, 30].includes(daysRaw) ? daysRaw : 7;

  try {
    const payload = await getAiQualitySample(accessToken, days);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(
      {
        days: payload.days,
        generated_at: payload.generatedAt,
        scope: payload.scope,
        traces: {
          total: payload.traces.total,
          by_decision: payload.traces.byDecision,
          by_kind: payload.traces.byKind,
          avg_confidence: payload.traces.avgConfidence,
          grounded_share: payload.traces.groundedShare,
          cited_share: payload.traces.citedShare,
          auto_reply_blocked_share: payload.traces.autoReplyBlockedShare,
          guard_blocked: payload.traces.guardBlocked,
          handoff_reasons: payload.traces.handoffReasons,
        },
        usage: payload.usage
          ? {
              calls: payload.usage.calls,
              failed: payload.usage.failed,
              fail_share: payload.usage.failShare,
              avg_latency_ms: payload.usage.avgLatencyMs,
            }
          : null,
        signals: payload.signals.map((s) => ({
          key: s.key,
          severity: s.severity,
          title: s.title,
          detail: s.detail,
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
