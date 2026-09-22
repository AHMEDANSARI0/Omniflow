import {
  enrollSequenceContacts,
  listSequenceEnrollments,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function GET(
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
    const enrollments = await listSequenceEnrollments(accessToken, sequenceId);
    if (enrollments === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(JSON.stringify({ enrollments }), {
      status: 200,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
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

export async function POST(
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

  let contacts: unknown = null;
  try {
    const payload: unknown = await request.json();
    if (payload !== null && typeof payload === "object") {
      contacts = (payload as Record<string, unknown>).contacts;
    }
  } catch {
    contacts = null;
  }
  if (!Array.isArray(contacts)) {
    return safeJson(
      { error: { code: "bad_request", message: "contacts must be a list." } },
      400
    );
  }
  const cleaned = contacts
    .filter((item): item is string => typeof item === "string")
    .slice(0, 50);
  if (cleaned.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "No valid contacts." } },
      400
    );
  }

  try {
    const result = await enrollSequenceContacts(accessToken, sequenceId, cleaned);
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "No valid contacts." } },
        400
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Sequence not found." } },
        404
      );
    }
    if (result.kind !== "ok") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(
      JSON.stringify({ enrolled: result.enrolled, skipped: result.skipped }),
      { status: 200, headers: { ...noStoreHeaders(), "Content-Type": "application/json" } }
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
