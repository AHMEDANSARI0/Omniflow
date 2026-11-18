import "server-only";

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { neonEnabled, neonQuery } from "../../lib/db/neon";
import { provisionDefaultWhatsAppEntitlements } from "../../lib/omniflow/entitlements";
import {
  getAdminAiOverview,
  listAdminUsers,
  resetAdminPassword,
} from "../../lib/omniflow/admin-control-plane";
import type {
  OmniFlowPrincipal,
  OmniFlowSessionTokens,
} from "../../lib/omniflow/control-plane";
import type {
  InstagramSettings,
  MetaSetupReport,
  SocialChannelAccount,
  SocialChannelId,
  SocialChannelsState,
  SocialMode,
  SocialPost,
  WhatsAppChannelStatus,
} from "../../lib/omniflow/portal";

export type ConnectorPlatform =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "tiktok"
  | "linkedin"
  | "x"
  | "youtube"
  | "telegram_user";

export type HybridMode = "api" | "login" | "hybrid";

export interface HybridConnectorFlags {
  dmEnabled: boolean;
  commentsEnabled: boolean;
  commentAutoReply: boolean;
  leadCaptureEnabled: boolean;
  webhookSubscribed: boolean;
  autoReconnect: boolean;
}

export interface HybridChannelConfig {
  platform: ConnectorPlatform;
  mode: HybridMode;
  enabled: boolean;
  connected: boolean;
  state: "connected" | "connecting" | "disconnected";
  autoFailover: boolean;
  activeTransport: "api" | "login" | "none";
  accountId: string;
  accountHandle: string;
  accountName: string;
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string;
  hasAccessToken: boolean;
  accessTokenMasked: string;
  pageId: string;
  organizationId: string;
  verifyToken: string;
  webhookUrl: string;
  loginUsername: string;
  hasLoginPassword: boolean;
  loginPasswordMasked: string;
  hasSessionCookie: boolean;
  sessionCookieMasked: string;
  twoFactorEnabled: boolean;
  bridgeUrl: string;
  bridgeAlive: boolean;
  waLinkMethod?: "qr" | "phone";
  waPairingPhone?: string;
  waPairingCode?: string | null;
  waQrPayload?: string;
  flags: HybridConnectorFlags;
  lastWebhookAt: string | null;
  lastBridgeAt: string | null;
  lastSentAt: string | null;
  lastSyncAt: string | null;
  lastError: string;
  sendError: string;
  updatedAt: string | null;
}

export type WorkspaceConnectorsMap = Record<ConnectorPlatform, HybridChannelConfig>;

export interface ClientWorkspaceRecord {
  id: number;
  client_id: number;
  workspace_name: string;
  email: string;
  display_name: string;
  role: string;
  status: "Active" | "Suspended" | "Locked";
  plan: "Starter" | "Growth" | "Enterprise";
  locked: boolean;
  failed_attempt_count: number;
  last_login_at: string | null;
  created_at: string;
  allowed_channels: ConnectorPlatform[];
  connectors: WorkspaceConnectorsMap;
}

export const ALL_CONNECTOR_PLATFORMS: ConnectorPlatform[] = [
  "whatsapp",
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
  "x",
  "youtube",
  "telegram_user",
];

export const SOCIAL_PLATFORM_IDS: SocialChannelId[] = [
  "tiktok",
  "x",
  "linkedin",
  "youtube",
  "telegram_user",
];

function maskSecret(val: string | undefined | null): string {
  const s = (val || "").trim();
  if (!s) return "";
  return s.length <= 8 ? "****" : s.slice(0, 4) + "••••" + s.slice(-4);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return "scrypt:" + salt + ":" + derived;
}

function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.startsWith("scrypt:")) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 3) return false;
  try {
    const derived = scryptSync(password, parts[1], 64);
    const expected = Buffer.from(parts[2], "hex");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function buildEmptyConnectorConfig(
  platform: ConnectorPlatform,
  origin = ""
): HybridChannelConfig {
  const suffix =
    platform === "instagram" || platform === "facebook"
      ? "/api/v1/public/meta/webhook"
      : "/api/v1/public/social/" + platform + "/webhook";
  return {
    platform,
    mode: platform === "telegram_user" ? "login" : "api",
    enabled: false,
    connected: false,
    state: "disconnected",
    autoFailover: false,
    activeTransport: "none",
    accountId: "",
    accountHandle: "",
    accountName: "",
    appId: "",
    hasAppSecret: false,
    appSecretMasked: "",
    hasAccessToken: false,
    accessTokenMasked: "",
    pageId: "",
    organizationId: "",
    verifyToken: "",
    webhookUrl: origin ? origin.replace(/\/$/, "") + suffix : suffix,
    loginUsername: "",
    hasLoginPassword: false,
    loginPasswordMasked: "",
    hasSessionCookie: false,
    sessionCookieMasked: "",
    twoFactorEnabled: false,
    bridgeUrl: "",
    bridgeAlive: false,
    flags: {
      dmEnabled: true,
      commentsEnabled: false,
      commentAutoReply: false,
      leadCaptureEnabled: true,
      webhookSubscribed: false,
      autoReconnect: true,
    },
    lastWebhookAt: null,
    lastBridgeAt: null,
    lastSentAt: null,
    lastSyncAt: null,
    lastError: "",
    sendError: "",
    updatedAt: null,
  };
}

export function defaultConnectors(origin = ""): WorkspaceConnectorsMap {
  return {
    whatsapp: buildEmptyConnectorConfig("whatsapp", origin),
    instagram: buildEmptyConnectorConfig("instagram", origin),
    facebook: buildEmptyConnectorConfig("facebook", origin),
    tiktok: buildEmptyConnectorConfig("tiktok", origin),
    linkedin: buildEmptyConnectorConfig("linkedin", origin),
    x: buildEmptyConnectorConfig("x", origin),
    youtube: buildEmptyConnectorConfig("youtube", origin),
    telegram_user: buildEmptyConnectorConfig("telegram_user", origin),
  };
}

async function loadConnectorsFromNeon(
  clientId: number,
  origin = ""
): Promise<WorkspaceConnectorsMap> {
  const map = defaultConnectors(origin);
  if (!neonEnabled()) return map;

  try {
    const waRes = await neonQuery<Record<string, unknown>>(
      "SELECT state, phone, account_name, last_seen_at, updated_at FROM portal_whatsapp_status WHERE client_id = $1 LIMIT 1",
      [clientId]
    );
    const wa = waRes.rows[0];
    if (wa) {
      const st =
        wa.state === "connected" || wa.state === "connecting"
          ? wa.state
          : "disconnected";
      map.whatsapp.state = st;
      map.whatsapp.connected = st === "connected";
      map.whatsapp.enabled = st !== "disconnected";
      map.whatsapp.activeTransport = st === "connected" ? "login" : "none";
      map.whatsapp.accountName = String(wa.account_name || "");
      map.whatsapp.accountHandle = String(wa.phone || "");
      map.whatsapp.loginUsername = String(wa.phone || "");
      map.whatsapp.bridgeAlive = st === "connected";
      map.whatsapp.lastBridgeAt = wa.last_seen_at
        ? new Date(String(wa.last_seen_at)).toISOString()
        : null;
    }
  } catch {
    // ignore
  }

  try {
    const igRes = await neonQuery<Record<string, unknown>>(
      "SELECT instagram_account_id, page_id, app_secret, access_token, page_access_token, verify_token, enabled, messenger_enabled, comments_enabled, comment_auto_reply, last_check_at, last_error, last_webhook_at, last_sent_at, send_error FROM portal_instagram_accounts WHERE client_id = $1 LIMIT 1",
      [clientId]
    );
    const ig = igRes.rows[0];
    if (ig) {
      const igConn = Boolean(ig.enabled && (ig.access_token || ig.instagram_account_id));
      map.instagram.enabled = Boolean(ig.enabled);
      map.instagram.connected = igConn;
      map.instagram.state = igConn ? "connected" : "disconnected";
      map.instagram.activeTransport = igConn ? "api" : "none";
      map.instagram.accountId = String(ig.instagram_account_id || "");
      map.instagram.pageId = String(ig.page_id || "");
      map.instagram.verifyToken = String(ig.verify_token || "");
      map.instagram.hasAccessToken = Boolean(ig.access_token);
      map.instagram.accessTokenMasked = maskSecret(String(ig.access_token || ""));
      map.instagram.hasAppSecret = Boolean(ig.app_secret);
      map.instagram.appSecretMasked = maskSecret(String(ig.app_secret || ""));
      map.instagram.flags.commentsEnabled = Boolean(ig.comments_enabled);
      map.instagram.flags.commentAutoReply = Boolean(ig.comment_auto_reply);
      map.instagram.lastSyncAt = ig.last_check_at
        ? new Date(String(ig.last_check_at)).toISOString()
        : null;
      map.instagram.lastWebhookAt = ig.last_webhook_at
        ? new Date(String(ig.last_webhook_at)).toISOString()
        : null;
      map.instagram.lastSentAt = ig.last_sent_at
        ? new Date(String(ig.last_sent_at)).toISOString()
        : null;
      map.instagram.lastError = String(ig.last_error || "");
      map.instagram.sendError = String(ig.send_error || "");

      const fbConn = Boolean(ig.messenger_enabled && (ig.page_access_token || ig.page_id));
      map.facebook.enabled = Boolean(ig.messenger_enabled);
      map.facebook.connected = fbConn;
      map.facebook.state = fbConn ? "connected" : "disconnected";
      map.facebook.pageId = String(ig.page_id || "");
      map.facebook.hasAccessToken = Boolean(ig.page_access_token);
      map.facebook.accessTokenMasked = maskSecret(String(ig.page_access_token || ""));
    }
  } catch {
    // ignore
  }

  try {
    const socRes = await neonQuery<Record<string, unknown>>(
      "SELECT channel, mode, enabled, connected, account_id, account_handle, account_name, app_id, app_secret, access_token, organization_id, verify_token, dm_enabled, comments_enabled, comment_auto_reply, last_webhook_at, last_bridge_at, last_sent_at, last_sync_at, last_error, send_error FROM portal_social_accounts WHERE client_id = $1",
      [clientId]
    );
    for (const row of socRes.rows) {
      const ch = String(row.channel || "") as ConnectorPlatform;
      if (!map[ch]) continue;
      const item = map[ch];
      item.mode = row.mode === "login" ? "login" : "api";
      item.enabled = Boolean(row.enabled);
      item.connected = Boolean(row.connected);
      item.state = row.connected ? "connected" : "disconnected";
      item.accountId = String(row.account_id || "");
      item.accountHandle = String(row.account_handle || "");
      item.accountName = String(row.account_name || "");
      item.appId = String(row.app_id || "");
      item.hasAppSecret = Boolean(row.app_secret);
      item.appSecretMasked = maskSecret(String(row.app_secret || ""));
      item.hasAccessToken = Boolean(row.access_token);
      item.accessTokenMasked = maskSecret(String(row.access_token || ""));
      item.organizationId = String(row.organization_id || "");
      item.verifyToken = String(row.verify_token || "");
      item.flags.dmEnabled = row.dm_enabled !== false;
      item.flags.commentsEnabled = Boolean(row.comments_enabled);
      item.flags.commentAutoReply = Boolean(row.comment_auto_reply);
      item.lastError = String(row.last_error || "");
      item.sendError = String(row.send_error || "");
    }
  } catch {
    // ignore
  }

  return map;
}

export async function listAllWorkspacesAndUsers(): Promise<ClientWorkspaceRecord[]> {
  const [cpUsersRes, aiOverviewRes] = await Promise.allSettled([
    listAdminUsers(),
    getAdminAiOverview(30),
  ]);
  const cpUsers = cpUsersRes.status === "fulfilled" ? cpUsersRes.value : [];
  const aiWorkspaces =
    aiOverviewRes.status === "fulfilled" ? aiOverviewRes.value.workspaces : [];
  const wsByEmail = new Map<string, { client_id: number; name: string }>();
  for (const ws of aiWorkspaces) {
    if (ws.email) wsByEmail.set(ws.email.toLowerCase(), { client_id: ws.client_id, name: ws.name });
  }

  const results: ClientWorkspaceRecord[] = [];
  const seen = new Set<string>();

  for (const u of cpUsers) {
    const emailLower = (u.email || "").toLowerCase();
    seen.add(emailLower);
    const matched = wsByEmail.get(emailLower);
    const clientId = matched?.client_id ?? u.id;
    const connectors = await loadConnectorsFromNeon(clientId);
    const st = (u.status || "active").toLowerCase();
    results.push({
      id: u.id,
      client_id: clientId,
      workspace_name: matched?.name || (u.display_name ? u.display_name + " Workspace" : "Workspace #" + clientId),
      email: u.email,
      display_name: u.display_name || u.email.split("@")[0] || "User " + u.id,
      role: "owner",
      status: u.locked ? "Locked" : st === "suspended" ? "Suspended" : "Active",
      plan: "Growth",
      locked: Boolean(u.locked),
      failed_attempt_count: Number(u.failed_attempt_count || 0),
      last_login_at: u.last_login_at,
      created_at: u.last_login_at || new Date().toISOString(),
      allowed_channels: [...ALL_CONNECTOR_PLATFORMS],
      connectors,
    });
  }

  if (neonEnabled()) {
    try {
      const dbRes = await neonQuery<Record<string, unknown>>(
        "SELECT pu.id, pu.email, pu.display_name, pu.status, pu.last_login_at, COALESCE(upc.failed_attempt_count, 0) AS failed_attempt_count, upc.locked_until FROM platform_users pu LEFT JOIN user_password_credentials upc ON upc.user_id = pu.id ORDER BY pu.id ASC"
      );
      for (const row of dbRes.rows) {
        const email = String(row.email || "");
        const emailLower = email.toLowerCase();
        if (!email || seen.has(emailLower)) continue;
        seen.add(emailLower);
        const uid = Number(row.id);
        const locked = Boolean(row.locked_until && new Date(String(row.locked_until)).getTime() > Date.now());
        const st = String(row.status || "active").toLowerCase();
        const connectors = await loadConnectorsFromNeon(uid);
        results.push({
          id: uid,
          client_id: uid,
          workspace_name: row.display_name ? String(row.display_name) + " Workspace" : "Workspace #" + uid,
          email,
          display_name: String(row.display_name || email.split("@")[0]),
          role: "owner",
          status: locked ? "Locked" : st === "suspended" ? "Suspended" : "Active",
          plan: "Growth",
          locked,
          failed_attempt_count: Number(row.failed_attempt_count || 0),
          last_login_at: row.last_login_at ? new Date(String(row.last_login_at)).toISOString() : null,
          created_at: row.last_login_at ? new Date(String(row.last_login_at)).toISOString() : new Date().toISOString(),
          allowed_channels: [...ALL_CONNECTOR_PLATFORMS],
          connectors,
        });
      }
    } catch {
      // ignore
    }
  }

  return results;
}

export async function createClientWorkspace(input: {
  workspace_name: string;
  display_name: string;
  email: string;
  password?: string;
  plan?: "Starter" | "Growth" | "Enterprise";
  status?: "Active" | "Suspended";
  allowed_channels?: ConnectorPlatform[];
}) {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("A valid email address is required.");
  if (!neonEnabled()) throw new Error("DATABASE_URL is required to create a platform user.");

  const tempPassword =
    input.password && input.password.trim().length >= 6
      ? input.password.trim()
      : "Omni-" + randomBytes(4).toString("hex") + "!9";
  const pwdHash = hashPassword(tempPassword);
  const statusDb = input.status === "Suspended" ? "suspended" : "active";

  const userRes = await neonQuery<{ id: number }>(
    "INSERT INTO platform_users (email, display_name, status) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, status = EXCLUDED.status RETURNING id",
    [email, input.display_name.trim() || email.split("@")[0], statusDb]
  );
  const userId = Number(userRes.rows[0]?.id || 0);
  if (!userId) throw new Error("Failed to insert user into platform_users.");

  await neonQuery(
    "INSERT INTO user_password_credentials (user_id, password_hash, password_changed_at, failed_attempt_count, locked_until) VALUES ($1, $2, NOW(), 0, NULL) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW(), failed_attempt_count = 0, locked_until = NULL",
    [userId, pwdHash]
  );

  await provisionDefaultWhatsAppEntitlements(userId);

  const connectors = await loadConnectorsFromNeon(userId);
  const record: ClientWorkspaceRecord = {
    id: userId,
    client_id: userId,
    workspace_name: input.workspace_name.trim() || input.display_name.trim() + " Workspace",
    email,
    display_name: input.display_name.trim() || email.split("@")[0],
    role: "owner",
    status: input.status === "Suspended" ? "Suspended" : "Active",
    plan: input.plan || "Growth",
    locked: false,
    failed_attempt_count: 0,
    last_login_at: null,
    created_at: new Date().toISOString(),
    allowed_channels: input.allowed_channels?.length ? input.allowed_channels : [...ALL_CONNECTOR_PLATFORMS],
    connectors,
  };
  return { workspace: record, user: record, temp_password: tempPassword };
}

export async function updateClientWorkspaceAccess(
  userId: number,
  updates: {
    locked?: boolean;
    status?: "Active" | "Suspended" | "Locked";
    plan?: "Starter" | "Growth" | "Enterprise";
    workspace_name?: string;
    allowed_channels?: ConnectorPlatform[];
  }
): Promise<ClientWorkspaceRecord | null> {
  if (neonEnabled()) {
    if (typeof updates.status === "string") {
      await neonQuery("UPDATE platform_users SET status = $1 WHERE id = $2", [
        updates.status === "Suspended" ? "suspended" : "active",
        userId,
      ]).catch(() => null);
    }
    if (typeof updates.locked === "boolean") {
      await neonQuery(
        "UPDATE user_password_credentials SET locked_until = $1, failed_attempt_count = CASE WHEN $2 THEN failed_attempt_count ELSE 0 END WHERE user_id = $3",
        [updates.locked ? new Date(Date.now() + 86400_000 * 30).toISOString() : null, updates.locked, userId]
      ).catch(() => null);
    }
  }
  const all = await listAllWorkspacesAndUsers();
  return all.find((u) => u.id === userId || u.client_id === userId) ?? null;
}

export async function resetClientWorkspacePassword(
  userId: number,
  customPassword?: string
): Promise<{ user_id: number; email: string; temp_password: string } | null> {
  if (!customPassword) {
    try {
      return await resetAdminPassword(userId);
    } catch {
      // fall back to direct Neon update
    }
  }
  if (!neonEnabled()) return null;
  const userRes = await neonQuery<{ id: number; email: string }>(
    "SELECT id, email FROM platform_users WHERE id = $1 LIMIT 1",
    [userId]
  );
  const user = userRes.rows[0];
  if (!user) return null;
  const tempPassword =
    customPassword && customPassword.trim().length >= 6
      ? customPassword.trim()
      : "Omni-" + randomBytes(4).toString("hex") + "!9";
  await neonQuery(
    "INSERT INTO user_password_credentials (user_id, password_hash, password_changed_at, failed_attempt_count, locked_until) VALUES ($1, $2, NOW(), 0, NULL) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW(), failed_attempt_count = 0, locked_until = NULL",
    [userId, hashPassword(tempPassword)]
  );
  return { user_id: user.id, email: user.email, temp_password: tempPassword };
}

export async function deleteClientWorkspace(userId: number): Promise<boolean> {
  if (!neonEnabled()) return false;
  try {
    await neonQuery("DELETE FROM user_password_credentials WHERE user_id = $1", [userId]);
    await neonQuery("DELETE FROM platform_users WHERE id = $1", [userId]);
    return true;
  } catch {
    return false;
  }
}

export async function getWorkspaceConnectorHubState(clientId: number, origin = "") {
  const connectors = await loadConnectorsFromNeon(clientId, origin);
  return {
    client_id: clientId,
    workspace_name: "Workspace #" + clientId,
    plan: "Growth",
    allowed_channels: [...ALL_CONNECTOR_PLATFORMS],
    connectors,
  };
}

export async function getWorkspaceWhatsAppState(clientId: number): Promise<WhatsAppChannelStatus> {
  const connectors = await loadConnectorsFromNeon(clientId);
  const wa = connectors.whatsapp;
  return {
    configured: wa.connected || wa.state === "connecting",
    state: wa.state,
    accountName: wa.accountName || null,
    phone: wa.accountHandle || null,
    lastSeenAt: wa.lastBridgeAt,
  };
}

export async function triggerWorkspaceWhatsAppAction(
  clientId: number,
  action: "connect" | "disconnect" | "restart",
  phone?: string,
  accountName?: string
) {
  const normalized = action === "disconnect" ? "disconnect" : "connect";
  if (neonEnabled()) {
    await neonQuery(
      "INSERT INTO portal_connector_commands (client_id, channel, action, payload, status, created_at, updated_at) VALUES ($1, 'whatsapp', $2, $3::jsonb, 'pending', NOW(), NOW())",
      [clientId, normalized, JSON.stringify({ phone, accountName })]
    ).catch(() => null);
  }
  const status = await getWorkspaceWhatsAppState(clientId);
  return {
    ok: true,
    message:
      normalized === "disconnect"
        ? "Disconnect request queued — the connector will log the WhatsApp session out."
        : "Connect request queued — the connector will link the WhatsApp account.",
    status,
  };
}

export async function getWorkspaceInstagramSettings(
  clientId: number,
  origin = ""
): Promise<InstagramSettings> {
  const connectors = await loadConnectorsFromNeon(clientId, origin);
  const ig = connectors.instagram;
  const fb = connectors.facebook;
  return {
    accountId: ig.accountId,
    pageId: ig.pageId || fb.pageId,
    enabled: ig.enabled,
    configured: Boolean(ig.accountId || ig.hasAccessToken || fb.pageId),
    messengerEnabled: fb.enabled,
    commentsEnabled: ig.flags.commentsEnabled,
    commentAutoReply: ig.flags.commentAutoReply,
    pageAccessTokenMasked: fb.accessTokenMasked,
    webhookPath: "/api/v1/public/meta/webhook",
    accessTokenMasked: ig.accessTokenMasked,
    appSecretMasked: ig.appSecretMasked,
    verifyTokenMasked: ig.verifyToken,
    lastCheckAt: ig.lastSyncAt,
    lastError: ig.lastError || null,
    cpSends: true,
    lastWebhookAt: ig.lastWebhookAt,
    lastSentAt: ig.lastSentAt,
    sendError: ig.sendError || null,
  };
}

export async function saveWorkspaceInstagramSettings(
  clientId: number,
  input: {
    enabled: boolean;
    instagramAccountId: string;
    pageId?: string;
    accessToken?: string;
    pageAccessToken?: string;
    appSecret?: string;
    verifyToken?: string;
    messengerEnabled?: boolean;
    commentsEnabled?: boolean;
    commentAutoReply?: boolean;
    regenerateVerifyToken?: boolean;
  },
  origin = ""
): Promise<InstagramSettings> {
  if (neonEnabled()) {
    const verifyToken = input.regenerateVerifyToken
      ? "of_meta_" + randomBytes(12).toString("hex")
      : input.verifyToken || "of_meta_" + clientId;
    await neonQuery(
      "INSERT INTO portal_instagram_accounts (client_id, instagram_account_id, page_id, enabled, messenger_enabled, comments_enabled, comment_auto_reply, verify_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (client_id) DO UPDATE SET instagram_account_id = EXCLUDED.instagram_account_id, page_id = EXCLUDED.page_id, enabled = EXCLUDED.enabled, messenger_enabled = EXCLUDED.messenger_enabled, comments_enabled = EXCLUDED.comments_enabled, comment_auto_reply = EXCLUDED.comment_auto_reply, verify_token = EXCLUDED.verify_token",
      [
        clientId,
        input.instagramAccountId.trim(),
        (input.pageId || "").trim(),
        Boolean(input.enabled),
        Boolean(input.messengerEnabled),
        Boolean(input.commentsEnabled),
        Boolean(input.commentAutoReply),
        verifyToken,
      ]
    ).catch(() => null);
  }
  return getWorkspaceInstagramSettings(clientId, origin);
}

export async function verifyWorkspaceInstagramSettings(clientId: number, origin = "") {
  const settings = await getWorkspaceInstagramSettings(clientId, origin);
  return {
    ok: settings.configured && Boolean(settings.accessTokenMasked),
    profile: { id: settings.accountId || "", username: null, name: null },
    page: settings.pageId ? { id: settings.pageId, name: null } : null,
    settings,
  };
}

export async function getWorkspaceMetaSetupReport(
  clientId: number,
  origin = ""
): Promise<MetaSetupReport> {
  const settings = await getWorkspaceInstagramSettings(clientId, origin);
  return {
    webhookUrl: origin ? origin.replace(/\/$/, "") + "/api/v1/public/meta/webhook" : "/api/v1/public/meta/webhook",
    queued: 0,
    app: null,
    note: "",
    checks: [
      {
        id: "ig_account",
        label: "Instagram Business Account ID",
        status: settings.accountId ? "ok" : "fail",
        detail: settings.accountId ? "Configured (" + settings.accountId + ")" : "Enter your Instagram Business Account ID.",
        fix: null,
      },
      {
        id: "access_token",
        label: "Meta Graph Access Token",
        status: settings.accessTokenMasked ? "ok" : "fail",
        detail: settings.accessTokenMasked ? "Saved (" + settings.accessTokenMasked + ")" : "Paste a Meta Graph API token.",
        fix: null,
      },
    ],
  };
}

export async function getWorkspaceSocialChannelsState(
  clientId: number,
  origin = ""
): Promise<SocialChannelsState> {
  const connectors = await loadConnectorsFromNeon(clientId, origin);
  const channels: SocialChannelAccount[] = SOCIAL_PLATFORM_IDS.map((id) => {
    const ch = connectors[id];
    const mode: SocialMode = ch.mode === "login" ? "login" : "api";
    return {
      channel: id,
      label: id.toUpperCase(),
      mode,
      modes: id === "telegram_user" ? ["login"] : ["api", "login"],
      capabilities: { api: ["dm", "comments", "publish"], login: ["dm", "comments", "publish"] },
      enabled: ch.enabled,
      flags: {
        dm: ch.flags.dmEnabled,
        comments: ch.flags.commentsEnabled,
        publish: true,
        comment_auto_reply: ch.flags.commentAutoReply,
      },
      app_id: ch.appId,
      app_secret_masked: ch.appSecretMasked,
      consumer_secret_masked: "",
      bearer_token_masked: "",
      organization_id: ch.organizationId,
      connected: ch.connected,
      bridge_live: ch.bridgeAlive,
      bridge_state: ch.connected ? "connected" : "disconnected",
      account_name: ch.accountName || ch.accountHandle,
      webhook_url: ch.webhookUrl,
      webhook_registered: ch.flags.webhookSubscribed,
      token_expires_at: null,
      last_check_at: ch.lastSyncAt,
      last_in_at: ch.lastWebhookAt,
      last_sent_at: ch.lastSentAt,
      last_error: ch.lastError,
      limits: [],
      post_max: 2200,
    };
  });
  return { available: true, can_edit: true, channels, posts: [] };
}

export async function saveHybridChannelConfig(
  clientId: number,
  platform: ConnectorPlatform,
  input: Partial<{
    mode: HybridMode;
    enabled: boolean;
    autoFailover: boolean;
    accountId: string;
    accountHandle: string;
    accountName: string;
    appId: string;
    appSecret: string;
    accessToken: string;
    pageAccessToken: string;
    pageId: string;
    organizationId: string;
    verifyToken: string;
    bearerToken: string;
    consumerSecret: string;
    loginUsername: string;
    loginPassword: string;
    sessionCookie: string;
    twoFactorEnabled: boolean;
    twoFactorCode: string;
    bridgeUrl: string;
    waLinkMethod: "qr" | "phone";
    flags: Partial<HybridConnectorFlags>;
  }>,
  origin = ""
): Promise<HybridChannelConfig> {
  if (platform === "instagram" || platform === "facebook") {
    await saveWorkspaceInstagramSettings(
      clientId,
      {
        enabled: input.enabled ?? true,
        instagramAccountId: input.accountId || "",
        pageId: input.pageId || "",
        accessToken: input.accessToken,
        pageAccessToken: input.pageAccessToken,
        appSecret: input.appSecret,
        verifyToken: input.verifyToken,
        messengerEnabled: platform === "facebook" ? (input.enabled ?? true) : undefined,
        commentsEnabled: input.flags?.commentsEnabled,
        commentAutoReply: input.flags?.commentAutoReply,
      },
      origin
    );
  } else if (neonEnabled() && (SOCIAL_PLATFORM_IDS as readonly string[]).includes(platform)) {
    await neonQuery(
      "INSERT INTO portal_social_accounts (client_id, channel, mode, enabled, account_handle, account_name, app_id, organization_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) ON CONFLICT (client_id, channel) DO UPDATE SET mode = EXCLUDED.mode, enabled = EXCLUDED.enabled, account_handle = EXCLUDED.account_handle, account_name = EXCLUDED.account_name, app_id = EXCLUDED.app_id, organization_id = EXCLUDED.organization_id, updated_at = NOW()",
      [
        clientId,
        platform,
        input.mode === "login" ? "login" : "api",
        Boolean(input.enabled ?? true),
        input.accountHandle || input.loginUsername || "",
        input.accountName || "",
        input.appId || "",
        input.organizationId || "",
      ]
    ).catch(() => null);
  }
  const map = await loadConnectorsFromNeon(clientId, origin);
  return map[platform];
}

export type HybridActionType =
  | "connect"
  | "disconnect"
  | "test"
  | "webhook"
  | "sync"
  | "refresh_qr"
  | "request_pairing_code"
  | "confirm_qr_scan"
  | "confirm_phone_code"
  | "login_session"
  | "failover_toggle";

export async function runHybridChannelAction(
  clientId: number,
  platform: ConnectorPlatform,
  action: HybridActionType,
  origin = "",
  extra?: { phone?: string; linkMethod?: "qr" | "phone" }
) {
  if (platform === "whatsapp") {
    const waAction = action === "disconnect" ? "disconnect" : "connect";
    const res = await triggerWorkspaceWhatsAppAction(clientId, waAction, extra?.phone);
    const map = await loadConnectorsFromNeon(clientId, origin);
    return { ok: res.ok, detail: res.message, connector: map.whatsapp };
  }
  const map = await loadConnectorsFromNeon(clientId, origin);
  return {
    ok: true,
    detail: "Action '" + action + "' sent to Control Plane for " + platform + ".",
    connector: map[platform],
  };
}

export async function saveWorkspaceSocialChannel(
  clientId: number,
  channel: SocialChannelId,
  body: Record<string, unknown>,
  origin = ""
): Promise<SocialChannelAccount> {
  await saveHybridChannelConfig(
    clientId,
    channel,
    {
      mode: body.mode === "login" ? "login" : "api",
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
      accountHandle: typeof body.account_handle === "string" ? body.account_handle : undefined,
      accountName: typeof body.account_name === "string" ? body.account_name : undefined,
      appId: typeof body.app_id === "string" ? body.app_id : undefined,
      organizationId: typeof body.organization_id === "string" ? body.organization_id : undefined,
    },
    origin
  );
  const state = await getWorkspaceSocialChannelsState(clientId, origin);
  return state.channels.find((c) => c.channel === channel)!;
}

export async function runWorkspaceSocialAction(
  clientId: number,
  channel: SocialChannelId,
  action: "connect" | "test" | "webhook" | "sync" | "disconnect",
  origin = ""
) {
  const res = await runHybridChannelAction(clientId, channel, action, origin);
  const state = await getWorkspaceSocialChannelsState(clientId, origin);
  return { ok: res.ok, detail: res.detail, settings: state.channels.find((c) => c.channel === channel) };
}

export async function createWorkspaceSocialPostRecord(
  clientId: number,
  channel: SocialChannelId,
  text: string,
  mediaUrl = "",
  origin = ""
): Promise<{ ok: boolean; status: string; post: SocialPost }> {
  void origin;
  if (neonEnabled()) {
    const res = await neonQuery<{ id: number; created_at: string }>(
      "INSERT INTO portal_social_posts (client_id, channel, text, media_url, status, created_at) VALUES ($1, $2, $3, $4, 'queued', NOW()) RETURNING id, created_at",
      [clientId, channel, text, mediaUrl]
    );
    const row = res.rows[0];
    if (row) {
      return {
        ok: true,
        status: "queued",
        post: {
          id: Number(row.id),
          channel,
          body: text,
          media_url: mediaUrl,
          status: "queued",
          source: "portal",
          provider_post_id: "",
          error: "",
          created_at: new Date(row.created_at).toISOString(),
        },
      };
    }
  }
  throw new Error("Control Plane database is required to queue social posts.");
}

export async function getUnifiedWorkspaceConnectors(clientId: number, origin = "") {
  const [hub, whatsapp, instagram, metaSetup, social] = await Promise.all([
    getWorkspaceConnectorHubState(clientId, origin),
    getWorkspaceWhatsAppState(clientId),
    getWorkspaceInstagramSettings(clientId, origin),
    getWorkspaceMetaSetupReport(clientId, origin),
    getWorkspaceSocialChannelsState(clientId, origin),
  ]);
  return {
    client_id: hub.client_id,
    workspace_name: hub.workspace_name,
    plan: hub.plan,
    allowed_channels: hub.allowed_channels,
    connectors: hub.connectors,
    whatsapp,
    instagram,
    meta_setup: metaSetup,
    social,
  };
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

let neonSessionReady = false;
async function ensureSessionTable(): Promise<boolean> {
  if (!neonEnabled()) return false;
  if (neonSessionReady) return true;
  try {
    await neonQuery(
      "CREATE TABLE IF NOT EXISTS portal_sessions_ext (session_id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, client_id BIGINT NOT NULL, email TEXT NOT NULL, display_name TEXT, role TEXT NOT NULL DEFAULT 'owner', access_token_hash TEXT NOT NULL, refresh_token_hash TEXT NOT NULL, access_expires_at TIMESTAMPTZ NOT NULL, refresh_expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    neonSessionReady = true;
    return true;
  } catch {
    return false;
  }
}

async function createSessionForRecord(
  userId: number,
  clientId: number,
  email: string,
  displayName: string,
  role = "owner"
): Promise<OmniFlowSessionTokens> {
  const sessionId = "ses_" + randomBytes(12).toString("hex");
  const accessToken = "ofa_neon_" + randomBytes(24).toString("hex");
  const refreshToken = "ofr_neon_" + randomBytes(24).toString("hex");
  const accessExpiresAt = new Date(Date.now() + 8 * 3600_000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();

  if (await ensureSessionTable()) {
    await neonQuery(
      "INSERT INTO portal_sessions_ext (session_id, user_id, client_id, email, display_name, role, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [sessionId, userId, clientId, email, displayName, role, sha256(accessToken), sha256(refreshToken), accessExpiresAt, refreshExpiresAt]
    ).catch(() => null);
  }
  return { sessionId, userId, clientId, role, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

export async function authenticatePortalClient(
  emailInput: string,
  passwordInput: string,
  clientId?: number
): Promise<
  | { kind: "ok"; tokens: OmniFlowSessionTokens }
  | { kind: "locked" }
  | { kind: "invalid" }
  | { kind: "not_found" }
> {
  void clientId;
  if (!neonEnabled()) return { kind: "not_found" };
  try {
    const res = await neonQuery<Record<string, unknown>>(
      "SELECT pu.id, pu.email, pu.display_name, pu.status, upc.password_hash, upc.locked_until FROM platform_users pu LEFT JOIN user_password_credentials upc ON upc.user_id = pu.id WHERE LOWER(pu.email) = $1 LIMIT 1",
      [emailInput.trim().toLowerCase()]
    );
    const row = res.rows[0];
    if (!row || !row.password_hash) return { kind: "not_found" };
    if (
      String(row.status || "").toLowerCase() === "suspended" ||
      (row.locked_until && new Date(String(row.locked_until)).getTime() > Date.now())
    ) {
      return { kind: "locked" };
    }
    if (!verifyPassword(passwordInput, String(row.password_hash))) {
      return { kind: "invalid" };
    }
    const uid = Number(row.id);
    const email = String(row.email);
    const tokens = await createSessionForRecord(uid, uid, email, String(row.display_name || email.split("@")[0]));
    return { kind: "ok", tokens };
  } catch {
    return { kind: "not_found" };
  }
}

export async function createAdminImpersonationSession(userId: number) {
  const all = await listAllWorkspacesAndUsers();
  const target = all.find((u) => u.id === userId || u.client_id === userId);
  if (!target) return null;
  const tokens = await createSessionForRecord(target.id, target.client_id, target.email, target.display_name, target.role);
  return { tokens, workspace: target };
}

export async function verifyPortalAccessToken(accessToken: string): Promise<OmniFlowPrincipal | null> {
  if (!accessToken.startsWith("ofa_neon_")) return null;
  if (!(await ensureSessionTable())) return null;
  try {
    const res = await neonQuery<Record<string, unknown>>(
      "SELECT session_id, user_id, client_id, role, email, display_name, access_expires_at, revoked FROM portal_sessions_ext WHERE access_token_hash = $1 LIMIT 1",
      [sha256(accessToken)]
    );
    const s = res.rows[0];
    if (!s || s.revoked || new Date(String(s.access_expires_at)).getTime() <= Date.now()) return null;
    return {
      sessionId: String(s.session_id),
      userId: Number(s.user_id),
      clientId: Number(s.client_id),
      role: String(s.role),
      email: String(s.email),
      displayName: s.display_name ? String(s.display_name) : null,
      accessExpiresAt: new Date(String(s.access_expires_at)).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function refreshPortalSessionToken(refreshToken: string): Promise<OmniFlowSessionTokens | null> {
  if (!refreshToken.startsWith("ofr_neon_")) return null;
  if (!(await ensureSessionTable())) return null;
  try {
    const res = await neonQuery<Record<string, unknown>>(
      "SELECT user_id, client_id, role, email, display_name, refresh_expires_at, revoked FROM portal_sessions_ext WHERE refresh_token_hash = $1 LIMIT 1",
      [sha256(refreshToken)]
    );
    const s = res.rows[0];
    if (!s || s.revoked || new Date(String(s.refresh_expires_at)).getTime() <= Date.now()) return null;
    const email = String(s.email);
    return createSessionForRecord(Number(s.user_id), Number(s.client_id), email, String(s.display_name || email.split("@")[0]), String(s.role));
  } catch {
    return null;
  }
}

export async function revokePortalSessionToken(accessToken: string): Promise<void> {
  if (!accessToken.startsWith("ofa_neon_")) return;
  if (!(await ensureSessionTable())) return;
  await neonQuery("UPDATE portal_sessions_ext SET revoked = TRUE WHERE access_token_hash = $1", [sha256(accessToken)]).catch(() => null);
}
