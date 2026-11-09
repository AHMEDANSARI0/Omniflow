import { getControlPlanePrincipal } from "../../../../../lib/omniflow/control-plane";
import { requirePortalAccessToken } from "../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../lib/omniflow/request-security";
import { publicOrigin } from "../../../../../lib/omniflow/social-bff";
import {
  ALL_CONNECTOR_PLATFORMS,
  createWorkspaceSocialPostRecord,
  getUnifiedWorkspaceConnectors,
  runHybridChannelAction,
  saveHybridChannelConfig,
  verifyWorkspaceInstagramSettings,
  type ConnectorPlatform,
  type HybridConnectorFlags,
  type HybridMode,
} from "../../../../lib/workspace-store";
import type { SocialChannelId } from "../../../../../lib/omniflow/portal";

async function resolveClientId(accessToken: string): Promise<number> {
  try {
    const principal = await getControlPlanePrincipal(accessToken);
    return principal.clientId || 1;
  } catch {
    return 1;
  }
}

function isPlatform(val: string): val is ConnectorPlatform {
  return (ALL_CONNECTOR_PLATFORMS as readonly string[]).includes(val);
}

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }
  const clientId = await resolveClientId(accessToken);
  const data = await getUnifiedWorkspaceConnectors(clientId, publicOrigin(request));
  return safeJson(data, 200);
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }
  const clientId = await resolveClientId(accessToken);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const platform = String(body.platform || "instagram");
  const origin = publicOrigin(request);

  if (isPlatform(platform)) {
    const mode: HybridMode =
      body.mode === "api" || body.mode === "login" || body.mode === "hybrid"
        ? body.mode
        : "hybrid";
    await saveHybridChannelConfig(
      clientId,
      platform,
      {
        mode,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        autoFailover: typeof body.auto_failover === "boolean" ? body.auto_failover : true,
        accountName: typeof body.account_name === "string" ? body.account_name : undefined,
        appId: typeof body.app_id === "string" ? body.app_id : undefined,
        appSecret: typeof body.app_secret === "string" ? body.app_secret : undefined,
        accessToken: typeof body.access_token === "string" ? body.access_token : undefined,
        pageId: typeof body.page_id === "string" ? body.page_id : undefined,
        organizationId: typeof body.organization_id === "string" ? body.organization_id : undefined,
        verifyToken: typeof body.verify_token === "string" ? body.verify_token : undefined,
        bearerToken: typeof body.bearer_token === "string" ? body.bearer_token : undefined,
        consumerSecret: typeof body.consumer_secret === "string" ? body.consumer_secret : undefined,
        loginUsername: typeof body.login_username === "string" ? body.login_username : undefined,
        loginPassword: typeof body.login_password === "string" ? body.login_password : undefined,
        sessionCookie: typeof body.session_cookie === "string" ? body.session_cookie : undefined,
        twoFactorCode: typeof body.two_factor_code === "string" ? body.two_factor_code : undefined,
        bridgeUrl: typeof body.bridge_url === "string" ? body.bridge_url : undefined,
        flags:
          body.flags && typeof body.flags === "object"
            ? (body.flags as Partial<HybridConnectorFlags>)
            : undefined,
      },
      origin
    );
  }

  const updated = await getUnifiedWorkspaceConnectors(clientId, origin);
  return safeJson({ ok: true, ...updated }, 200);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }
  const clientId = await resolveClientId(accessToken);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = String(body.kind || "action");
  const origin = publicOrigin(request);

  if (kind === "verify_meta") {
    const verification = await verifyWorkspaceInstagramSettings(clientId);
    const updated = await getUnifiedWorkspaceConnectors(clientId, origin);
    return safeJson({ ...verification, ...updated }, 200);
  }

  if (kind === "publish_post") {
    const channel = String(body.channel || "tiktok") as SocialChannelId;
    const text = String(body.text || "").trim();
    const mediaUrl = String(body.media_url || "").trim();
    await createWorkspaceSocialPostRecord(clientId, channel, text, mediaUrl, origin);
    const updated = await getUnifiedWorkspaceConnectors(clientId, origin);
    return safeJson({ ok: true, ...updated }, 200);
  }

  const platform = String(body.channel || body.platform || "instagram");
  const action = String(body.action || "connect") as
    | "connect"
    | "connect_api"
    | "connect_login"
    | "test"
    | "webhook"
    | "sync"
    | "disconnect";

  if (isPlatform(platform)) {
    await runHybridChannelAction(clientId, platform, action, origin);
  }
  const updated = await getUnifiedWorkspaceConnectors(clientId, origin);
  return safeJson({ ok: true, ...updated }, 200);
}
