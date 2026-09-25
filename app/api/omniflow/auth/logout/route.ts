import {
  ControlPlaneRequestError,
  logoutControlPlaneSession,
  refreshControlPlaneSession,
} from "../../../../../lib/omniflow/control-plane";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";
import {
  clearSessionCookies,
  readSessionCookies,
} from "../../../../../lib/omniflow/session-cookies";


async function revokeRemoteSession(
  accessToken: string | null,
  refreshToken: string | null
): Promise<void> {
  if (accessToken) {
    try {
      await logoutControlPlaneSession(accessToken);
      return;
    } catch (error) {
      if (!(error instanceof ControlPlaneRequestError) || error.status !== 401) {
        throw error;
      }
    }
  }

  if (refreshToken) {
    const rotated = await refreshControlPlaneSession(refreshToken);
    await logoutControlPlaneSession(rotated.accessToken);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const { accessToken, refreshToken } = await readSessionCookies();

  try {
    await revokeRemoteSession(accessToken, refreshToken);
  } catch {
    // Local cookies are still cleared. Any unreachable remote session remains
    // digest-only and can be revoked by the Control Plane session controls.
  } finally {
    await clearSessionCookies();
  }

  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
