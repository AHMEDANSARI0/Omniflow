import {
  addOptOut,
  listOptOuts,
  removeOptOut,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const params = new URL(request.url).searchParams;
  const query = (params.get("q") || "").trim();
  if (query.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "q is too long." } },
      400
    );
  }

  try {
    const optouts = await listOptOuts(accessToken, query);
    if (optouts === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ optouts }, 200);
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


export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const contact = String(body.contact || "").trim();
  const reason = String(body.reason || "customer");
  if (!contact || contact.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }
  if (!["customer", "merchant"].includes(reason)) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick customer or merchant." } },
      400
    );
  }

  try {
    const saved = await addOptOut(accessToken, contact, reason);
    if (saved === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(saved, 200);
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


export async function DELETE(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const params = new URL(request.url).searchParams;
  const contact = (params.get("contact") || "").trim();
  if (!contact || contact.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }

  try {
    const removed = await removeOptOut(accessToken, contact);
    if (removed === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (removed === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Not in the opt-out list." } },
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
