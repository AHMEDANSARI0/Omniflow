import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getBusinessProfile,
  requirePortalAccessToken,
  saveBusinessProfile,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
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
    const profile = await getBusinessProfile(accessToken);
    return safeJson(profile, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    profile?: unknown;
  } | null;
  const profile =
    payload !== null &&
    typeof payload === "object" &&
    payload.profile !== null &&
    typeof payload.profile === "object"
      ? (payload.profile as Record<string, unknown>)
      : null;
  if (!profile) {
    return safeJson(
      { error: { code: "bad_request", message: "Profile object missing." } },
      400
    );
  }

  const stringProfile: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value === "string") stringProfile[key] = value;
  }

  try {
    const result = await saveBusinessProfile(accessToken, stringProfile);
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
