import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createBrand,
  listBrands,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const brands = await listBrands(accessToken);
    if (brands === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ brands }, 200);
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
  const payload = (await request.json().catch(() => null)) as {
    name?: unknown;
  } | null;
  const name =
    payload && typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) {
    return safeJson(
      { error: { code: "bad_request", message: "Brand name is required." } },
      400
    );
  }
  try {
    const result = await createBrand(accessToken, name);
    if (!result.ok) {
      return safeJson(
        {
          error: {
            code: result.status === 409 ? "conflict" : "portal_unavailable",
            message:
              result.status === 409
                ? "A brand with this name already exists."
                : "Try again shortly.",
          },
        },
        result.status === 409 ? 409 : 503
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
