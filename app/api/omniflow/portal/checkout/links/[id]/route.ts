import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  setCheckoutLinkStatus,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}


export async function PATCH(
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

  const { id } = await context.params;
  const linkId = parseId(id);
  if (linkId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid link id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const status = typeof input.status === "string" ? input.status.trim() : "";
  if (!status) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick a status." } },
      400
    );
  }
  const reason =
    typeof input.reason === "string" ? input.reason.trim() : "";

  try {
    const result = await setCheckoutLinkStatus(
      accessToken,
      linkId,
      status,
      reason || undefined
    );
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Link not found." } },
        404
      );
    }
    if (result === "forbidden") {
      return safeJson(
        {
          error: {
            code: "forbidden",
            message: "Only owners can mark links paid.",
          },
        },
        403
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
