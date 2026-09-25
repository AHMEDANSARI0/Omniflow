import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteCustomerMemory,
  requirePortalAccessToken,
  updateCustomerMemory,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

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
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    content?: unknown;
  } | null;
  const content =
    payload && typeof payload.content === "string"
      ? payload.content.trim()
      : "";
  if (!content) {
    return safeJson(
      { error: { code: "bad_request", message: "content is required." } },
      400
    );
  }

  try {
    const ok = await updateCustomerMemory(accessToken, id, content);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "No such entry." } },
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
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  try {
    const ok = await deleteCustomerMemory(accessToken, id);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "No such entry." } },
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
