import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteCustomerMemory,
  requirePortalAccessToken,
  updateCustomerMemory,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

function parseId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

const MTYPES = ["short", "long", "business", "journey"];
const MAX_EXPIRY_HOURS = 8760;

export async function PUT(
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
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    content?: unknown;
    mtype?: unknown;
    expires_hours?: unknown;
  } | null;
  const content =
    payload && typeof payload.content === "string"
      ? payload.content.trim()
      : "";
  if (!content) {
    return safeJson(
      { error: { code: "bad_request", message: "content is required." } },
      400
    );
  }
  if (
    payload?.mtype !== undefined &&
    (typeof payload.mtype !== "string" || !MTYPES.includes(payload.mtype))
  ) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message:
            "mtype must be one of short|long|business|journey.",
        },
      },
      400
    );
  }
  let expiresHours: number | undefined;
  if (payload?.expires_hours !== undefined) {
    if (
      typeof payload.expires_hours !== "number" ||
      !Number.isFinite(payload.expires_hours) ||
      payload.expires_hours < 0 ||
      payload.expires_hours > MAX_EXPIRY_HOURS
    ) {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "expires_hours must be between 0 and " +
              MAX_EXPIRY_HOURS + ".",
          },
        },
        400
      );
    }
    expiresHours = Math.round(payload.expires_hours);
  }

  try {
    const ok = await updateCustomerMemory(
      accessToken,
      id,
      content,
      payload?.mtype as "short" | "long" | "business" | "journey" | undefined,
      expiresHours
    );
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "No such entry." } },
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
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  try {
    const ok = await deleteCustomerMemory(accessToken, id);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "No such entry." } },
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
