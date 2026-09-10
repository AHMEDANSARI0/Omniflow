import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  deleteCustomerNote,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

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

  const { id } = await context.params;
  const noteId = Number.parseInt(id, 10);
  if (!Number.isFinite(noteId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid note id." } },
      400
    );
  }

  try {
    const result = await deleteCustomerNote(accessToken, noteId);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Note not found." } },
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
