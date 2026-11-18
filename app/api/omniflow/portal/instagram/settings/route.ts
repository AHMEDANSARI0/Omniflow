import { neonEnabled, neonQuery } from "../../../../../../lib/db/neon";
import { authorizePortalOperation } from "../../../../../../lib/omniflow/authz";
import {
  ControlPlaneRequestError,
  getControlPlanePrincipal,
} from "../../../../../../lib/omniflow/control-plane";
import {
  getInstagramSettings,
  requirePortalAccessToken,
  saveInstagramSettings,
  type InstagramSettings,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

function maskSecret(val: string | null | undefined): string {
  const s = (val || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

async function readNeonInstagramSettings(clientId: number): Promise<InstagramSettings | null> {
  if (!neonEnabled()) return null;
  try {
    const res = await neonQuery<{
      instagram_account_id: string | null;
      page_id: string | null;
      app_secret: string | null;
      access_token: string | null;
      page_access_token: string | null;
      verify_token: string | null;
      enabled: boolean | null;
      messenger_enabled: boolean | null;
      comments_enabled: boolean | null;
      comment_auto_reply: boolean | null;
      last_check_at: string | null;
      last_error: string | null;
      last_webhook_at: string | null;
      last_sent_at: string | null;
      send_error: string | null;
    }>(
      `SELECT instagram_account_id, page_id, app_secret, access_token, page_access_token,
              verify_token, enabled, messenger_enabled, comments_enabled, comment_auto_reply,
              last_check_at, last_error, last_webhook_at, last_sent_at, send_error
       FROM portal_instagram_accounts
       WHERE client_id = $1
       LIMIT 1`,
      [clientId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      accountId: row.instagram_account_id ?? "",
      pageId: row.page_id ?? "",
      enabled: Boolean(row.enabled),
      configured: Boolean(row.instagram_account_id || row.access_token || row.page_id),
      messengerEnabled: Boolean(row.messenger_enabled),
      commentsEnabled: Boolean(row.comments_enabled),
      commentAutoReply: Boolean(row.comment_auto_reply),
      pageAccessTokenMasked: maskSecret(row.page_access_token),
      webhookPath: "/api/v1/public/meta/webhook",
      accessTokenMasked: maskSecret(row.access_token),
      appSecretMasked: maskSecret(row.app_secret),
      verifyTokenMasked: row.verify_token ?? "",
      lastCheckAt: row.last_check_at ? new Date(row.last_check_at).toISOString() : null,
      lastError: row.last_error ?? null,
      cpSends: true,
      lastWebhookAt: row.last_webhook_at ? new Date(row.last_webhook_at).toISOString() : null,
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
      sendError: row.send_error ?? null,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const auth = await authorizePortalOperation({
    feature: "workspace.instagram_connector",
    connector: "instagram",
    permission: "read",
  });
  if (!auth.ok) return auth.response;
  const accessToken = auth.accessToken;

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const settings = await getInstagramSettings(accessToken);
      if (settings) {
        return safeJson({ settings }, 200);
      }
    } catch (error) {
      if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
        return safeJson(
          { error: { code: "unauthorized", message: "Sign in required." } },
          401
        );
      }
    }
  }

  try {
    const principal = await getControlPlanePrincipal(accessToken);
    const neonSettings = await readNeonInstagramSettings(principal.clientId);
    if (neonSettings) {
      return safeJson({ settings: neonSettings }, 200);
    }
  } catch {
    // fall through
  }

  return safeJson(
    {
      settings: {
        accountId: "",
        pageId: "",
        enabled: false,
        configured: false,
        messengerEnabled: false,
        commentsEnabled: false,
        commentAutoReply: false,
        pageAccessTokenMasked: "",
        webhookPath: "/api/v1/public/meta/webhook",
        accessTokenMasked: "",
        appSecretMasked: "",
        verifyTokenMasked: "",
        lastCheckAt: null,
        lastError: null,
        cpSends: true,
        lastWebhookAt: null,
        lastSentAt: null,
        sendError: null,
      } satisfies InstagramSettings,
    },
    200
  );
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const auth = await authorizePortalOperation({
    feature: "workspace.instagram_connector",
    connector: "instagram",
    permission: "update",
  });
  if (!auth.ok) return auth.response;
  const accessToken = auth.accessToken;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const input = {
    enabled: Boolean(body.enabled),
    accountId: String(body.account_id ?? body.instagram_account_id ?? body.accountId ?? "").trim(),
    pageId: String(body.page_id ?? body.pageId ?? "").trim(),
    accessTokenValue: String(body.access_token ?? body.accessTokenValue ?? "").trim(),
    pageAccessToken: String(body.page_access_token ?? body.pageAccessToken ?? "").trim(),
    appSecret: String(body.app_secret ?? body.appSecret ?? "").trim(),
    verifyToken: String(body.verify_token ?? body.verifyToken ?? "").trim(),
    messengerEnabled: Boolean(body.messenger_enabled ?? body.messengerEnabled),
    commentsEnabled: Boolean(body.comments_enabled ?? body.commentsEnabled),
    commentAutoReply: Boolean(body.comment_auto_reply ?? body.commentAutoReply),
  };

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const saved = await saveInstagramSettings(accessToken, input);
      if (saved && "invalid" in saved) {
        return safeJson(
          { error: { code: "bad_request", message: saved.invalid } },
          400
        );
      }
      if (saved && "ok" in saved) {
        const fresh = await getInstagramSettings(accessToken).catch(() => null);
        return safeJson({ ok: true, requiresCheck: saved.requiresCheck, settings: fresh }, 200);
      }
    } catch (error) {
      if (error instanceof ControlPlaneRequestError) {
        return safeJson(
          { error: { code: error.code, message: error.message } },
          error.status
        );
      }
    }
  }

  return safeJson(
    {
      error: {
        code: "instagram_unavailable",
        message: "The Control Plane could not save Meta settings right now.",
      },
    },
    503
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
