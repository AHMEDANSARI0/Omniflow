import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  dismissIdentityPair,
  requirePortalAccessToken,
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
    contact_a?: unknown;
    contact_b?: unknown;
  } | null;
  const contactA =
    payload && typeof payload.contact_a === "string"
      ? payload.contact_a.trim()
      : "";
  const contactB =
    payload && typeof payload.contact_b === "string"
      ? payload.contact_b.trim()
      : "";
  if (!contactA || !contactB || contactA === contactB) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick two different contacts." } },
      400
    );
  }

  try {
    const ok = await dismissIdentityPair(accessToken, contactA, contactB);
    if (!ok) {
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
