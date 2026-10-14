import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  splitIdentity,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    contact?: unknown;
  } | null;
  const contact =
    payload && typeof payload.contact === "string" ? payload.contact.trim() : "";
  if (!contact) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }

  try {
    const result = await splitIdentity(accessToken, contact);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if ("error" in result) {
      return safeJson(
        { error: { code: "not_linked", message: result.error } },
        404
      );
    }
    return safeJson({ ok: true, identity: result.identity }, 200);
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
