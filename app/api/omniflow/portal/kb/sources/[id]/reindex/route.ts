import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";
import {
  reindexKbSource,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../../lib/omniflow/request-security";

function parseId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (!id) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid source id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    text?: unknown;
  } | null;
  const text =
    payload && typeof payload.text === "string" && payload.text.trim()
      ? payload.text
      : undefined;

  try {
    const result = await reindexKbSource(accessToken, id, text);
    if (result.kind === "unavailable") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: result.code, message: result.message } },
        result.status
      );
    }
    return safeJson({ ok: true, source: result.source }, 200);
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
