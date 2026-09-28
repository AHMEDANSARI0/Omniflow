import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listEscalations,
  raiseEscalation,
  requirePortalAccessToken,
  type EscalationStatus,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = { error: { code: "portal_unavailable", message: "Try again shortly." } };

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const params = new URL(request.url).searchParams;
  const rawStatus = (params.get("status") ?? "open").trim();
  const status: EscalationStatus | "all" =
    rawStatus === "resolved" || rawStatus === "all" ? rawStatus : "open";
  const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
  try {
    const payload = await listEscalations(accessToken, status, limit);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(payload, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const payload = (await request.json().catch(() => null)) as {
    conversation_id?: unknown;
    note?: unknown;
    user_id?: unknown;
  } | null;
  const conversationId =
    payload && typeof payload.conversation_id === "number" && payload.conversation_id > 0
      ? Math.floor(payload.conversation_id)
      : 0;
  if (!conversationId) {
    return safeJson(
      { error: { code: "bad_request", message: "conversation_id is required." } },
      400
    );
  }
  const userId =
    payload && typeof payload.user_id === "number" && payload.user_id > 0
      ? Math.floor(payload.user_id)
      : undefined;
  const note = payload && typeof payload.note === "string" ? payload.note.trim().slice(0, 300) : "";
  try {
    const result = await raiseEscalation(accessToken, {
      conversation_id: conversationId,
      note: note || undefined,
      user_id: userId,
    });
    if (result.kind === "unavailable") return safeJson(DOWN, 503);
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: result.code, message: result.message } },
        result.status
      );
    }
    return safeJson(result.data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
