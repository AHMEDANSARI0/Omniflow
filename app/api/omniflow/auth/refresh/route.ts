import {
  ControlPlaneRequestError,
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
  writeSessionCookies,
} from "../../../../../lib/omniflow/session-cookies";


export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const { refreshToken } = await readSessionCookies();
  if (!refreshToken) {
    await clearSessionCookies();
    return safeJson(
      { error: { code: "invalid_refresh_token", message: "Sign in again." } },
      401
    );
  }

  try {
    const session = await refreshControlPlaneSession(refreshToken);
    await writeSessionCookies(session);
    return new Response(null, { status: 204, headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.status === 401) {
      await clearSessionCookies();
      return safeJson(
        { error: { code: "invalid_refresh_token", message: "Sign in again." } },
        401
      );
    }

    return safeJson(
      {
        error: {
          code: "authentication_unavailable",
          message: "Session refresh is temporarily unavailable.",
        },
      },
      503
    );
  }
}
