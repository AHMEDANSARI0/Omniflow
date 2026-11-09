import {
  ControlPlaneRequestError,
  getControlPlanePrincipal,
} from "../../../../../../lib/omniflow/control-plane";
import {
  getInstagramSettings,
  requirePortalAccessToken,
  saveInstagramSettings,
} from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";
import {
  getWorkspaceInstagramSettings,
  saveWorkspaceInstagramSettings,
} from "../../../../../lib/workspace-store";

async function resolveClientId(accessToken: string): Promise<number> {
  try {
    const p = await getControlPlanePrincipal(accessToken);
    return p.clientId || 1;
  } catch {
    return 1;
  }
}

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const clientId = await resolveClientId(accessToken);
  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const cpSettings = await getInstagramSettings(accessToken);
      if (cpSettings && cpSettings.configured) {
        return safeJson({ settings: cpSettings }, 200);
      }
    } catch (error) {
      if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
        return safeJson(
          { error: { code: "unauthorized", message: "Session expired." } },
          401
        );
      }
    }
  }
  const settings = await getWorkspaceInstagramSettings(clientId);
  return safeJson({ settings }, 200);
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
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const input = payload && typeof payload === "object" ? payload : {};
  const clientId = await resolveClientId(accessToken);

  const localSaved = await saveWorkspaceInstagramSettings(clientId, {
    enabled: input.enabled === true,
    mode:
      input.mode === "api" || input.mode === "login" || input.mode === "hybrid"
        ? input.mode
        : undefined,
    accountId: typeof input.account_id === "string" ? input.account_id.trim() : "",
    instagramHandle:
      typeof input.instagram_handle === "string" ? input.instagram_handle.trim() : undefined,
    pageId: typeof input.page_id === "string" ? input.page_id.trim() : "",
    facebookPageName:
      typeof input.facebook_page_name === "string" ? input.facebook_page_name.trim() : undefined,
    accessTokenValue:
      typeof input.access_token === "string" ? input.access_token.trim() : "",
    appSecret: typeof input.app_secret === "string" ? input.app_secret.trim() : "",
    verifyToken:
      typeof input.verify_token === "string" ? input.verify_token.trim() : "",
    pageAccessToken:
      typeof input.page_access_token === "string" ? input.page_access_token.trim() : "",
    loginUsername:
      typeof input.login_username === "string" ? input.login_username.trim() : undefined,
    loginPassword:
      typeof input.login_password === "string" ? input.login_password.trim() : undefined,
    sessionCookie:
      typeof input.session_cookie === "string" ? input.session_cookie.trim() : undefined,
    messengerEnabled: input.messenger_enabled === true,
    commentsEnabled: input.comments_enabled === true,
    commentAutoReply: input.comment_auto_reply === true,
  });

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const cpResult = await saveInstagramSettings(accessToken, {
        enabled: input.enabled === true,
        accountId: typeof input.account_id === "string" ? input.account_id.trim() : "",
        pageId: typeof input.page_id === "string" ? input.page_id.trim() : "",
        accessTokenValue:
          typeof input.access_token === "string" ? input.access_token.trim() : "",
        appSecret: typeof input.app_secret === "string" ? input.app_secret.trim() : "",
        verifyToken:
          typeof input.verify_token === "string" ? input.verify_token.trim() : "",
        pageAccessToken:
          typeof input.page_access_token === "string" ? input.page_access_token.trim() : "",
        messengerEnabled: input.messenger_enabled === true,
        commentsEnabled: input.comments_enabled === true,
        commentAutoReply: input.comment_auto_reply === true,
      });
      if (cpResult && !("invalid" in cpResult)) {
        return safeJson(cpResult, 200);
      }
    } catch {
      // Fall back to Neon workspace store result
    }
  }

  return safeJson(localSaved, 200);
}
