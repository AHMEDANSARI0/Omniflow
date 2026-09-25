import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getCourierSettings,
  putCourierSettings,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const payload = await getCourierSettings(accessToken);
    if (payload === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(payload, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    provider?: unknown;
    api_key?: unknown;
    api_password?: unknown;
    base_url?: unknown;
    enabled?: unknown;
  } | null;
  const provider =
    payload && typeof payload.provider === "string"
      ? payload.provider
      : "";
  if (!provider) {
    return safeJson(
      { error: { code: "bad_request", message: "provider is required." } },
      400
    );
  }

  try {
    const result = await putCourierSettings(accessToken, {
      provider,
      api_key:
        typeof payload?.api_key === "string" ? payload.api_key : "",
      api_password:
        typeof payload?.api_password === "string"
          ? payload.api_password
          : "",
      base_url:
        typeof payload?.base_url === "string" ? payload.base_url : "",
      enabled: payload?.enabled === false ? false : true,
    });
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(result, 200);
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
