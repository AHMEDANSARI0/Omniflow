import {
  linkContacts,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const contactA = typeof input.contact_a === "string" ? input.contact_a.trim() : "";
  const contactB = typeof input.contact_b === "string" ? input.contact_b.trim() : "";
  if (
    !contactA ||
    !contactB ||
    contactA.length > 100 ||
    contactB.length > 100
  ) {
    return safeJson(
      { error: { code: "bad_request", message: "Both contacts are required." } },
      400
    );
  }
  if (contactA === contactB) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick two different contacts." } },
      400
    );
  }

  try {
    const result = await linkContacts(accessToken, contactA, contactB);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
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
