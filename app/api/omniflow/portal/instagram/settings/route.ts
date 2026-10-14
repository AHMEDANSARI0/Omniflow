import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getInstagramSettings,
  requirePortalAccessToken,
  saveInstagramSettings,
} from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const settings = await getInstagramSettings(accessToken);
    if (settings === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
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
  try {
    const result = await saveInstagramSettings(accessToken, {
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
    if (result !== null && "invalid" in result) {
      return safeJson({ error: { code: "bad_request", message: result.invalid } }, 400);
    }
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
