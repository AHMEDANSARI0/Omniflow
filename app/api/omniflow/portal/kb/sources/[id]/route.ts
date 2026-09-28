import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  deleteKbSource,
  requirePortalAccessToken,
  type KbSourceStatus,
  updateKbSource,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

const STATUSES = ["draft", "published", "paused"];

function parseId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function PUT(
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
    status?: unknown;
    title?: unknown;
  } | null;
  const status =
    payload && typeof payload.status === "string" &&
    STATUSES.includes(payload.status)
      ? (payload.status as KbSourceStatus)
      : undefined;
  const title =
    payload && typeof payload.title === "string" ? payload.title.trim() : "";
  if (!status && !title) {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }

  try {
    const result = await updateKbSource(accessToken, id, {
      status,
      title: title || undefined,
    });
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

export async function DELETE(
  _request: Request,
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

  try {
    const result = await deleteKbSource(accessToken, id);
    if (result === "unavailable") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "No such source." } },
        404
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
