import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  replayDelivery,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

function parseReplayInput(payload: { id?: unknown } | null):
  | { kind: "ok"; id: number }
  | { kind: "error"; message: string } {
  const id = payload?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return { kind: "error", message: "id (positive integer) is required." };
  }
  return { kind: "ok", id };
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  const parsed = parseReplayInput(payload);
  if (parsed.kind === "error") {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const result = await replayDelivery(accessToken, parsed.id);
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "id (positive integer) is required." } },
        400
      );
    }
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "No replayable delivery found." } },
        404
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
