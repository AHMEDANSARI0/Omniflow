import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getCodSettings,
  requirePortalAccessToken,
  saveCodSettings,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getCodSettings(accessToken);
    if (settings === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "COD confirmations are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ settings }, 200);
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

export async function PUT(request: Request) {
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
  const template = typeof input.template === "string" ? input.template.trim() : "";
  const enabled = input.enabled === true;
  if (!template) {
    return safeJson(
      { error: { code: "bad_request", message: "Template text is required." } },
      400
    );
  }

  try {
    const ok = await saveCodSettings(accessToken, { enabled, template });
    if (ok) {
      return safeJson({ ok: true, settings: { enabled, template } }, 200);
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
