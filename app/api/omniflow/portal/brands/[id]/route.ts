import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteBrand,
  requirePortalAccessToken,
  updateBrand,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

function notFound() {
  return safeJson(
    { error: { code: "not_found", message: "Brand not found." } },
    404
  );
}

export async function PATCH(
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
  const brandId = Number.parseInt(id, 10);
  if (!Number.isFinite(brandId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid brand id." } },
      400
    );
  }
  const payload = (await request.json().catch(() => null)) as {
    name?: unknown;
    isActive?: unknown;
  } | null;
  const changes: { name?: string; isActive?: boolean } = {};
  if (payload && typeof payload === "object") {
    if (typeof payload.name === "string" && payload.name.trim()) {
      changes.name = payload.name.trim();
    }
    if (typeof payload.isActive === "boolean") {
      changes.isActive = payload.isActive;
    }
  }
  if (Object.keys(changes).length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }
  try {
    const result = await updateBrand(accessToken, brandId, changes);
    if (!result.ok) {
      if (result.status === 404) return notFound();
      if (result.status === 409) {
        return safeJson(
          {
            error: {
              code: "conflict",
              message: "A brand with this name already exists.",
            },
          },
          409
        );
      }
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

export async function DELETE(
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
  const brandId = Number.parseInt(id, 10);
  if (!Number.isFinite(brandId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid brand id." } },
      400
    );
  }
  try {
    const result = await deleteBrand(accessToken, brandId);
    if (!result.ok) {
      if (result.status === 404) return notFound();
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

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
