import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  getCatalogSyncSettings,
  putCatalogSyncSettings,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const result = await getCatalogSyncSettings(accessToken);
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

export async function PUT(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const payload = (await request.json().catch(() => null)) as {
    source?: unknown;
    base_url?: unknown;
    api_key?: unknown;
    api_secret?: unknown;
  } | null;
  const source =
    payload && typeof payload.source === "string" ? payload.source.trim() : "";
  const baseUrl =
    payload && typeof payload.base_url === "string"
      ? payload.base_url.trim()
      : "";
  if (!source || !baseUrl) {
    return safeJson(
      { error: { code: "bad_request", message: "source and base_url are required." } },
      400
    );
  }
  try {
    const ok = await putCatalogSyncSettings(accessToken, {
      source,
      base_url: baseUrl,
      api_key:
        payload && typeof payload.api_key === "string"
          ? payload.api_key.trim()
          : undefined,
      api_secret:
        payload && typeof payload.api_secret === "string"
          ? payload.api_secret.trim()
          : undefined,
    });
    if (!ok) {
      return safeJson(
        { error: { code: "bad_request", message: "Check the sync settings - they were refused." } },
        400
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
