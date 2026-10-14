import {
  getApprovalsConfig,
  requirePortalAccessToken,
  saveApprovalsConfig,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const config = await getApprovalsConfig(accessToken);
    if (config === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(config, 200);
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
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
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
  const number = String(body.approvalNumber || "").trim();
  const hours = Number(body.autoExpireHours || 24);
  try {
    const result = await saveApprovalsConfig(
      accessToken,
      number,
      Number.isFinite(hours) ? hours : 24
    );
    if (result === "bad_request") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "WhatsApp number mukammal likhein (e.g. 92300...).",
          },
        },
        400
      );
    }
    if (result === "forbidden") {
      return safeJson(
        {
          error: {
            code: "forbidden",
            message: "Sirf owner approval settings badal sakta hai.",
          },
        },
        403
      );
    }
    if (result === null) {
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
