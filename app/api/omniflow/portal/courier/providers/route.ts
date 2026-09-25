import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  createCourierProvider,
  listCourierProviders,
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
    const result = await listCourierProviders(accessToken);
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
    adapter?: unknown;
    base_url?: unknown;
    api_key?: unknown;
    api_secret?: unknown;
    booking_mode?: unknown;
  } | null;
  const name =
    payload && typeof payload.name === "string" ? payload.name.trim() : "";
  const adapter =
    payload && typeof payload.adapter === "string"
      ? payload.adapter.trim()
      : "";
  if (!name || !adapter) {
    return safeJson(
      { error: { code: "bad_request", message: "name and adapter are required." } },
      400
    );
  }
  try {
    const result = await createCourierProvider(accessToken, {
      name,
      adapter,
      base_url:
        payload && typeof payload.base_url === "string"
          ? payload.base_url.trim()
          : undefined,
      api_key:
        payload && typeof payload.api_key === "string"
          ? payload.api_key.trim()
          : undefined,
      api_secret:
        payload && typeof payload.api_secret === "string"
          ? payload.api_secret.trim()
          : undefined,
      booking_mode:
        payload && typeof payload.booking_mode === "string"
          ? payload.booking_mode
          : undefined,
    });
    if (result === null) {
      return safeJson(
        { error: { code: "bad_request", message: "Check the details - the control plane refused the provider." } },
        400
      );
    }
    return safeJson(result, 201);
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
