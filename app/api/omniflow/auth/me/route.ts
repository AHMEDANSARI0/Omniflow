import {
  ControlPlaneRequestError,
  getControlPlanePrincipal,
} from "../../../../../lib/omniflow/control-plane";
import { safeJson } from "../../../../../lib/omniflow/request-security";
import { readSessionCookies } from "../../../../../lib/omniflow/session-cookies";


export async function GET() {
  const { accessToken } = await readSessionCookies();
  if (!accessToken) {
    return safeJson(
      { error: { code: "invalid_access_token", message: "Sign in required." } },
      401
    );
  }

  try {
    const principal = await getControlPlanePrincipal(accessToken);
    return safeJson({
      session_id: principal.sessionId,
      user_id: principal.userId,
      client_id: principal.clientId,
      role: principal.role,
      email: principal.email,
      display_name: principal.displayName,
      access_expires_at: principal.accessExpiresAt,
    });
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.status === 401) {
      return safeJson(
        { error: { code: "invalid_access_token", message: "Session refresh required." } },
        401
      );
    }

    return safeJson(
      {
        error: {
          code: "authentication_unavailable",
          message: "Session verification is temporarily unavailable.",
        },
      },
      503
    );
  }
}
