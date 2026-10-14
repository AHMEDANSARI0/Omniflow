import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  resolveEscalation,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = { error: { code: "portal_unavailable", message: "Try again shortly." } };

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const { id: rawId } = await context.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid escalation id." } },
      400
    );
  }
  const payload = (await request.json().catch(() => null)) as { note?: unknown } | null;
  const note = payload && typeof payload.note === "string" ? payload.note.trim().slice(0, 300) : "";
  try {
    const result = await resolveEscalation(accessToken, id, note);
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
