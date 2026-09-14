import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteSequence,
  requirePortalAccessToken,
  updateSequence,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const changes: { name?: string; enabled?: boolean } = {};
  if (typeof input.name === "string") changes.name = input.name;
  if (typeof input.enabled === "boolean") changes.enabled = input.enabled;
  if (Object.keys(changes).length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }

  try {
    const result = await updateSequence(accessToken, sequenceId, changes);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Sequence not found." } },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
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
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  try {
    const result = await deleteSequence(accessToken, sequenceId);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Sequence not found." } },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
