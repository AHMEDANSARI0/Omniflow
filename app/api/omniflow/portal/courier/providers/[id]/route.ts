import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  deleteCourierProvider,
  requirePortalAccessToken,
  updateCourierProvider,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
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
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (!id) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }
  const payload = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!payload || typeof payload !== "object") {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }
  const patch: Record<string, unknown> = {};
  for (const key of [
    "name",
    "base_url",
    "booking_mode",
    "enabled",
    "api_key",
    "api_secret",
  ] as const) {
    if (typeof payload[key] === "string" && payload[key] !== "") {
      patch[key] = (payload[key] as string).trim();
    }
    if (key === "enabled" && typeof payload[key] === "boolean") {
      patch[key] = payload[key];
    }
  }
  try {
    const ok = await updateCourierProvider(accessToken, id, patch);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "Provider not found or the update was refused." } },
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
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }
  try {
    const ok = await deleteCourierProvider(accessToken, id);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "Provider not found." } },
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
