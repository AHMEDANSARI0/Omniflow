import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  removeIdentityHandle,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

function parseId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
      { error: { code: "bad_request", message: "Invalid handle id." } },
      400
    );
  }

  try {
    const result = await removeIdentityHandle(accessToken, id);
    if (result === "unavailable") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "No such handle." } },
        404
      );
    }
    if (result === "protected") {
      return safeJson(
        {
          error: {
            code: "protected",
            message:
              "WhatsApp ids cannot be removed. Use Unlink on the linked contact instead.",
          },
        },
        400
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
