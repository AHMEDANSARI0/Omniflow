import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  addCustomerNote,
  listCustomerNotes,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const contactId = (url.searchParams.get("contact_id") || "").trim().slice(0, 120);
  if (!contactId) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id is required." } },
      400
    );
  }

  try {
    const notes = await listCustomerNotes(accessToken, contactId);
    if (notes === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, notes }, 200);
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

  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const contactId = typeof body.contact_id === "string" ? body.contact_id.trim().slice(0, 120) : "";
  const noteBody = typeof body.body === "string" ? body.body.trim().slice(0, 1000) : "";
  if (!contactId || !noteBody) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id and note text are required." } },
      400
    );
  }

  try {
    const result = await addCustomerNote(accessToken, contactId, noteBody);
    if (result.kind === "ok") {
      return safeJson({ ok: true, note: result.note }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Note must be 1-1000 characters." } },
        400
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
