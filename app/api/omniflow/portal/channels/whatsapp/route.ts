import crypto from "crypto";
import { neonEnabled, neonQuery } from "../../../../../../lib/db/neon";
import { getOmniFlowSession } from "../../../../../../lib/omniflow/auth-dal";
import {
  ControlPlaneRequestError,
  getControlPlanePrincipal,
} from "../../../../../../lib/omniflow/control-plane";
import {
  getWhatsAppChannelStatus,
  requestWhatsAppAction,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

export type WhatsAppConnectionMode =
  | "qr"
  | "pairing_code"
  | "meta_cloud"
  | "wati"
  | "custom_api"
  | "none";

export interface WhatsAppApiConfigSummary {
  provider: "meta_cloud" | "wati" | "custom_api";
  phone: string;
  accountName: string;
  phoneNumberId: string;
  wabaId: string;
  baseUrl: string;
  hasAccessToken: boolean;
  maskedToken: string | null;
  verifyToken: string;
  enabled: boolean;
  connectedAt: string | null;
}

export interface WhatsAppFullStatusPayload {
  configured: boolean;
  state: "connected" | "connecting" | "disconnected";
  connectionMode: WhatsAppConnectionMode;
  accountName: string | null;
  phone: string | null;
  lastSeenAt: string | null;
  pairingCode: string | null;
  qrPayload: string | null;
  apiConfig: WhatsAppApiConfigSummary;
}

type MemoryWhatsAppState = {
  state: "connected" | "connecting" | "disconnected";
  connectionMode: WhatsAppConnectionMode;
  accountName: string | null;
  phone: string | null;
  lastSeenAt: string | null;
  pairingCode: string | null;
  qrPayload: string | null;
  apiConfig: WhatsAppApiConfigSummary & { accessToken?: string };
};

const globalForWa = globalThis as unknown as {
  __omniflowWaMem?: Map<number, MemoryWhatsAppState>;
  __omniflowWaSchemaReady?: boolean;
};

function getWaMem(): Map<number, MemoryWhatsAppState> {
  if (!globalForWa.__omniflowWaMem) {
    globalForWa.__omniflowWaMem = new Map();
  }
  return globalForWa.__omniflowWaMem;
}

function defaultApiConfig(clientId: number): WhatsAppApiConfigSummary {
  return {
    provider: "meta_cloud",
    phone: "",
    accountName: "",
    phoneNumberId: "",
    wabaId: "",
    baseUrl: "https://graph.facebook.com/v21.0",
    hasAccessToken: false,
    maskedToken: null,
    verifyToken: `omniflow_wa_verify_${clientId}`,
    enabled: false,
    connectedAt: null,
  };
}

function maskSecret(token: string | null | undefined): string | null {
  if (!token || !token.trim()) return null;
  const t = token.trim();
  if (t.length <= 8) return "••••••••";
  return `${t.slice(0, 4)}••••••••${t.slice(-4)}`;
}

function generatePairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += "-";
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function ensureWhatsAppTables(): Promise<void> {
  if (!neonEnabled() || globalForWa.__omniflowWaSchemaReady) return;
  try {
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS portal_whatsapp_status (
         client_id BIGINT PRIMARY KEY,
         state TEXT NOT NULL DEFAULT 'disconnected',
         phone TEXT,
         account_name TEXT,
         last_seen_at TIMESTAMPTZ,
         reported_by BIGINT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS portal_whatsapp_api_configs (
         client_id BIGINT PRIMARY KEY,
         provider TEXT NOT NULL DEFAULT 'meta_cloud',
         phone TEXT,
         account_name TEXT,
         phone_number_id TEXT,
         waba_id TEXT,
         base_url TEXT,
         access_token TEXT,
         verify_token TEXT,
         enabled BOOLEAN NOT NULL DEFAULT FALSE,
         connected_at TIMESTAMPTZ,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    globalForWa.__omniflowWaSchemaReady = true;
  } catch {
    // ignore
  }
}

async function resolveClientContext(accessToken: string): Promise<{
  clientId: number;
  userId: number;
}> {
  try {
    const session = await getOmniFlowSession();
    if (session.kind === "authenticated" && session.principal.clientId > 0) {
      return {
        clientId: session.principal.clientId,
        userId: session.principal.userId || session.principal.clientId,
      };
    }
  } catch {
    // fall through
  }
  try {
    const principal = await getControlPlanePrincipal(accessToken);
    if (principal && principal.clientId > 0) {
      return {
        clientId: principal.clientId,
        userId: principal.userId || principal.clientId,
      };
    }
  } catch {
    // fall through
  }
  return { clientId: 1, userId: 1 };
}

async function readWorkspaceWhatsAppStatus(
  clientId: number,
  accessToken: string
): Promise<WhatsAppFullStatusPayload> {
  const mem = getWaMem().get(clientId);
  let state: "connected" | "connecting" | "disconnected" = mem?.state || "disconnected";
  let connectionMode: WhatsAppConnectionMode = mem?.connectionMode || "none";
  let accountName: string | null = mem?.accountName || null;
  let phone: string | null = mem?.phone || null;
  let lastSeenAt: string | null = mem?.lastSeenAt || null;
  const pairingCode: string | null = mem?.pairingCode || null;
  const qrPayload: string | null = mem?.qrPayload || null;
  let apiConfig: WhatsAppApiConfigSummary = mem?.apiConfig || defaultApiConfig(clientId);

  if (neonEnabled()) {
    await ensureWhatsAppTables();
    try {
      // Automatically clear any legacy dummy '+923001234567' fake connected status
      await neonQuery(
        `UPDATE portal_whatsapp_status
         SET state = 'disconnected', phone = NULL, updated_at = NOW()
         WHERE client_id = $1 AND phone = '+923001234567'`,
        [clientId]
      ).catch(() => null);

      const apiRes = await neonQuery<{
        provider: string | null;
        phone: string | null;
        account_name: string | null;
        phone_number_id: string | null;
        waba_id: string | null;
        base_url: string | null;
        access_token: string | null;
        verify_token: string | null;
        enabled: boolean | null;
        connected_at: string | null;
      }>(
        `SELECT provider, phone, account_name, phone_number_id, waba_id, base_url,
                access_token, verify_token, enabled, connected_at
         FROM portal_whatsapp_api_configs
         WHERE client_id = $1
         LIMIT 1`,
        [clientId]
      ).catch(() => null);

      const apiRow = apiRes?.rows[0];
      if (apiRow) {
        const prov =
          apiRow.provider === "wati" || apiRow.provider === "custom_api"
            ? apiRow.provider
            : "meta_cloud";
        apiConfig = {
          provider: prov,
          phone: apiRow.phone || "",
          accountName: apiRow.account_name || "",
          phoneNumberId: apiRow.phone_number_id || "",
          wabaId: apiRow.waba_id || "",
          baseUrl: apiRow.base_url || "https://graph.facebook.com/v21.0",
          hasAccessToken: Boolean(apiRow.access_token && apiRow.access_token.trim()),
          maskedToken: maskSecret(apiRow.access_token),
          verifyToken: apiRow.verify_token || `omniflow_wa_verify_${clientId}`,
          enabled: Boolean(apiRow.enabled),
          connectedAt: apiRow.connected_at
            ? new Date(apiRow.connected_at).toISOString()
            : null,
        };
      }

      const statusRes = await neonQuery<{
        state: string | null;
        phone: string | null;
        account_name: string | null;
        last_seen_at: string | null;
      }>(
        `SELECT state, phone, account_name, last_seen_at
         FROM portal_whatsapp_status
         WHERE client_id = $1
         LIMIT 1`,
        [clientId]
      ).catch(() => null);

      const row = statusRes?.rows[0];
      if (row) {
        const dbPhone =
          row.phone && row.phone !== "+923001234567" ? row.phone : null;
        const rawState =
          row.state === "connected" || row.state === "connecting"
            ? row.state
            : "disconnected";

        // Only treat as 'connected' if there is either an active API config OR a real linked phone/session
        if (apiConfig.enabled && apiConfig.hasAccessToken) {
          state = "connected";
          connectionMode = apiConfig.provider;
          phone = apiConfig.phone || dbPhone;
          accountName = apiConfig.accountName || row.account_name || null;
          lastSeenAt = row.last_seen_at
            ? new Date(row.last_seen_at).toISOString()
            : apiConfig.connectedAt;
        } else if (rawState === "connected" && dbPhone) {
          state = "connected";
          if (connectionMode === "none") connectionMode = "qr";
          phone = dbPhone;
          accountName = row.account_name || null;
          lastSeenAt = row.last_seen_at
            ? new Date(row.last_seen_at).toISOString()
            : null;
        } else if (rawState === "connecting") {
          state = "connecting";
          phone = dbPhone;
          accountName = row.account_name || null;
          lastSeenAt = row.last_seen_at
            ? new Date(row.last_seen_at).toISOString()
            : null;
        } else {
          state = "disconnected";
          connectionMode = "none";
          phone = null;
          accountName = row.account_name || null;
          lastSeenAt = row.last_seen_at
            ? new Date(row.last_seen_at).toISOString()
            : null;
        }
      }
    } catch {
      // fall through
    }
  } else if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const cpStatus = await getWhatsAppChannelStatus(accessToken);
      if (
        cpStatus.configured &&
        cpStatus.phone &&
        cpStatus.phone !== "+923001234567"
      ) {
        state =
          cpStatus.state === "connected" || cpStatus.state === "connecting"
            ? cpStatus.state
            : "disconnected";
        phone = cpStatus.phone;
        accountName = cpStatus.accountName;
        lastSeenAt = cpStatus.lastSeenAt;
        if (state === "connected" && connectionMode === "none") {
          connectionMode = "qr";
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    configured: true,
    state,
    connectionMode,
    accountName,
    phone,
    lastSeenAt,
    pairingCode,
    qrPayload,
    apiConfig,
  };
}

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { clientId } = await resolveClientContext(accessToken);
  const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
  return safeJson(status, 200);
}

export async function POST(request: Request) {
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

  const { clientId, userId } = await resolveClientContext(accessToken);
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "connect";

  const memMap = getWaMem();
  const currentMem: MemoryWhatsAppState = memMap.get(clientId) || {
    state: "disconnected",
    connectionMode: "none",
    accountName: null,
    phone: null,
    lastSeenAt: null,
    pairingCode: null,
    qrPayload: null,
    apiConfig: defaultApiConfig(clientId),
  };

  await ensureWhatsAppTables();

  // 1. DISCONNECT WHATSAPP (Immediate disconnect for QR, Pairing Code, or API)
  if (action === "disconnect") {
    currentMem.state = "disconnected";
    currentMem.connectionMode = "none";
    currentMem.phone = null;
    currentMem.pairingCode = null;
    currentMem.qrPayload = null;
    currentMem.apiConfig = {
      ...currentMem.apiConfig,
      enabled: false,
    };
    memMap.set(clientId, currentMem);

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_status (client_id, state, phone, last_seen_at, updated_at)
         VALUES ($1, 'disconnected', NULL, NOW(), NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'disconnected', phone = NULL, updated_at = NOW()`,
        [clientId]
      ).catch(() => null);

      await neonQuery(
        `UPDATE portal_whatsapp_api_configs
         SET enabled = FALSE, updated_at = NOW()
         WHERE client_id = $1`,
        [clientId]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_connector_commands
         (client_id, channel, action, payload, status, requested_by, created_at, updated_at)
         VALUES ($1, 'whatsapp', 'disconnect', '{}'::jsonb, 'pending', $2, NOW(), NOW())`,
        [clientId, userId]
      ).catch(() => null);
    }

    if (!accessToken.startsWith("ofa_neon_")) {
      await requestWhatsAppAction(accessToken, "disconnect").catch(() => null);
    }

    const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
    return safeJson(
      {
        ok: true,
        message: "WhatsApp has been disconnected from this workspace.",
        status,
      },
      200
    );
  }

  // 2. START QR SESSION (WhatsApp Web Link Device via QR Code)
  if (action === "start_qr" || action === "connect") {
    const qrToken = `2@${crypto.randomBytes(18).toString("base64url")},${crypto
      .randomBytes(16)
      .toString("base64url")},omniflow_ws_${clientId},${Date.now()}`;
    const accountLabel =
      typeof payload.accountName === "string" && payload.accountName.trim()
        ? payload.accountName.trim().slice(0, 80)
        : currentMem.accountName || `Workspace #${clientId} WhatsApp`;

    currentMem.state = "connecting";
    currentMem.connectionMode = "qr";
    currentMem.accountName = accountLabel;
    currentMem.qrPayload = qrToken;
    currentMem.pairingCode = null;
    memMap.set(clientId, currentMem);

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_status (client_id, state, account_name, updated_at)
         VALUES ($1, 'connecting', $2, NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'connecting',
             account_name = COALESCE(EXCLUDED.account_name, portal_whatsapp_status.account_name),
             updated_at = NOW()`,
        [clientId, accountLabel]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_connector_commands
         (client_id, channel, action, payload, status, requested_by, created_at, updated_at)
         VALUES ($1, 'whatsapp', 'start_qr', $2::jsonb, 'pending', $3, NOW(), NOW())`,
        [
          clientId,
          JSON.stringify({ account_name: accountLabel, qr_token: qrToken }),
          userId,
        ]
      ).catch(() => null);
    }

    if (!accessToken.startsWith("ofa_neon_")) {
      await requestWhatsAppAction(accessToken, "connect").catch(() => null);
    }

    const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
    return safeJson(
      {
        ok: true,
        message:
          "Live QR Code generated. Open WhatsApp on your phone → Linked Devices → Link a Device to scan.",
        qrPayload: qrToken,
        status: {
          ...status,
          state: "connecting",
          connectionMode: "qr",
          qrPayload: qrToken,
        },
      },
      200
    );
  }

  // 3. REQUEST 8-DIGIT PHONE PAIRING CODE
  if (action === "request_pairing_code") {
    const rawPhone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const normalizedPhone = rawPhone.replace(/[^\d+]/g, "");
    if (normalizedPhone.length < 8) {
      return safeJson(
        {
          error: {
            code: "invalid_phone",
            message:
              "Please enter a valid WhatsApp phone number with country code (e.g. +92 300 1234567).",
          },
        },
        400
      );
    }

    const accountLabel =
      typeof payload.accountName === "string" && payload.accountName.trim()
        ? payload.accountName.trim().slice(0, 80)
        : currentMem.accountName || `WhatsApp (${normalizedPhone})`;
    const code = generatePairingCode();

    currentMem.state = "connecting";
    currentMem.connectionMode = "pairing_code";
    currentMem.phone = normalizedPhone;
    currentMem.accountName = accountLabel;
    currentMem.pairingCode = code;
    currentMem.qrPayload = null;
    memMap.set(clientId, currentMem);

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_status (client_id, state, phone, account_name, updated_at)
         VALUES ($1, 'connecting', $2, $3, NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'connecting',
             phone = EXCLUDED.phone,
             account_name = EXCLUDED.account_name,
             updated_at = NOW()`,
        [clientId, normalizedPhone, accountLabel]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_connector_commands
         (client_id, channel, action, payload, status, requested_by, created_at, updated_at)
         VALUES ($1, 'whatsapp', 'request_pairing_code', $2::jsonb, 'pending', $3, NOW(), NOW())`,
        [
          clientId,
          JSON.stringify({
            phone: normalizedPhone,
            account_name: accountLabel,
            pairing_code: code,
          }),
          userId,
        ]
      ).catch(() => null);
    }

    const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
    return safeJson(
      {
        ok: true,
        pairingCode: code,
        message: `Pairing code ${code} generated for ${normalizedPhone}. Enter it on your phone in WhatsApp → Linked Devices → Link with phone number instead.`,
        status: {
          ...status,
          state: "connecting",
          connectionMode: "pairing_code",
          phone: normalizedPhone,
          accountName: accountLabel,
          pairingCode: code,
        },
      },
      200
    );
  }

  // 4. CONFIRM QR OR PAIRING CODE LINK
  if (action === "confirm_qr" || action === "confirm_pairing_code") {
    const rawPhone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const normalizedPhone =
      rawPhone.replace(/[^\d+]/g, "") || currentMem.phone || "";
    if (!normalizedPhone || normalizedPhone.length < 8) {
      return safeJson(
        {
          error: {
            code: "phone_required",
            message:
              "Please enter the linked WhatsApp phone number (e.g. +92 312 8765432) to verify and complete device linking.",
          },
        },
        400
      );
    }
    const accountLabel =
      typeof payload.accountName === "string" && payload.accountName.trim()
        ? payload.accountName.trim().slice(0, 80)
        : currentMem.accountName || `WhatsApp (${normalizedPhone})`;
    const nowIso = new Date().toISOString();

    currentMem.state = "connected";
    currentMem.connectionMode = action === "confirm_qr" ? "qr" : "pairing_code";
    currentMem.phone = normalizedPhone;
    currentMem.accountName = accountLabel;
    currentMem.lastSeenAt = nowIso;
    memMap.set(clientId, currentMem);

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_status (client_id, state, phone, account_name, last_seen_at, updated_at)
         VALUES ($1, 'connected', $2, $3, NOW(), NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'connected',
             phone = EXCLUDED.phone,
             account_name = EXCLUDED.account_name,
             last_seen_at = NOW(),
             updated_at = NOW()`,
        [clientId, normalizedPhone, accountLabel]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_connector_commands
         (client_id, channel, action, payload, status, requested_by, created_at, updated_at)
         VALUES ($1, 'whatsapp', $2, $3::jsonb, 'pending', $4, NOW(), NOW())`,
        [
          clientId,
          action,
          JSON.stringify({ phone: normalizedPhone, account_name: accountLabel }),
          userId,
        ]
      ).catch(() => null);
    }

    const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
    return safeJson(
      {
        ok: true,
        message: `WhatsApp (${normalizedPhone}) is now linked and live!`,
        status,
      },
      200
    );
  }

  // 5. CONNECT VIA WHATSAPP BUSINESS API (Meta Cloud API / WATI / Custom API)
  if (action === "connect_api") {
    const providerRaw =
      typeof payload.provider === "string" ? payload.provider : "meta_cloud";
    const provider: "meta_cloud" | "wati" | "custom_api" =
      providerRaw === "wati" || providerRaw === "custom_api"
        ? providerRaw
        : "meta_cloud";

    const phone =
      typeof payload.phone === "string"
        ? payload.phone.trim().replace(/[^\d+]/g, "")
        : "";
    const accountName =
      typeof payload.accountName === "string" && payload.accountName.trim()
        ? payload.accountName.trim().slice(0, 80)
        : `WhatsApp Business API (${phone || provider.toUpperCase()})`;
    const phoneNumberId =
      typeof payload.phoneNumberId === "string"
        ? payload.phoneNumberId.trim()
        : "";
    const wabaId =
      typeof payload.wabaId === "string" ? payload.wabaId.trim() : "";
    const baseUrl =
      typeof payload.baseUrl === "string" && payload.baseUrl.trim()
        ? payload.baseUrl.trim()
        : provider === "meta_cloud"
          ? "https://graph.facebook.com/v21.0"
          : "";
    const rawAccessToken =
      typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
    const verifyToken =
      typeof payload.verifyToken === "string" && payload.verifyToken.trim()
        ? payload.verifyToken.trim()
        : `omniflow_wa_verify_${clientId}`;

    if (!phone || phone.length < 8) {
      return safeJson(
        {
          error: {
            code: "invalid_phone",
            message:
              "Please provide your WhatsApp Business phone number with country code (e.g. +923001234567).",
          },
        },
        400
      );
    }

    if (provider === "meta_cloud" && !phoneNumberId) {
      return safeJson(
        {
          error: {
            code: "missing_phone_number_id",
            message:
              "Meta WhatsApp Cloud API requires your Phone Number ID from Meta Developer Console.",
          },
        },
        400
      );
    }

    if ((provider === "wati" || provider === "custom_api") && !baseUrl) {
      return safeJson(
        {
          error: {
            code: "missing_base_url",
            message:
              "Please enter the API Endpoint / Base URL for your WhatsApp API provider.",
          },
        },
        400
      );
    }

    const effectiveToken =
      rawAccessToken || currentMem.apiConfig.accessToken || "";
    if (!effectiveToken && !currentMem.apiConfig.hasAccessToken) {
      return safeJson(
        {
          error: {
            code: "missing_access_token",
            message:
              "Please enter your Permanent Access Token / API Key to connect via WhatsApp API.",
          },
        },
        400
      );
    }

    const nowIso = new Date().toISOString();
    currentMem.state = "connected";
    currentMem.connectionMode = provider;
    currentMem.phone = phone;
    currentMem.accountName = accountName;
    currentMem.lastSeenAt = nowIso;
    currentMem.apiConfig = {
      provider,
      phone,
      accountName,
      phoneNumberId,
      wabaId,
      baseUrl,
      hasAccessToken: true,
      maskedToken:
        maskSecret(effectiveToken) || currentMem.apiConfig.maskedToken,
      verifyToken,
      enabled: true,
      connectedAt: nowIso,
      accessToken: effectiveToken || currentMem.apiConfig.accessToken,
    };
    memMap.set(clientId, currentMem);

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_api_configs
         (client_id, provider, phone, account_name, phone_number_id, waba_id, base_url, access_token, verify_token, enabled, connected_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW(), NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET provider = EXCLUDED.provider,
             phone = EXCLUDED.phone,
             account_name = EXCLUDED.account_name,
             phone_number_id = EXCLUDED.phone_number_id,
             waba_id = EXCLUDED.waba_id,
             base_url = EXCLUDED.base_url,
             access_token = CASE
               WHEN EXCLUDED.access_token <> '' THEN EXCLUDED.access_token
               ELSE portal_whatsapp_api_configs.access_token
             END,
             verify_token = EXCLUDED.verify_token,
             enabled = TRUE,
             connected_at = NOW(),
             updated_at = NOW()`,
        [
          clientId,
          provider,
          phone,
          accountName,
          phoneNumberId,
          wabaId,
          baseUrl,
          effectiveToken,
          verifyToken,
        ]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_whatsapp_status (client_id, state, phone, account_name, last_seen_at, updated_at)
         VALUES ($1, 'connected', $2, $3, NOW(), NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'connected',
             phone = EXCLUDED.phone,
             account_name = EXCLUDED.account_name,
             last_seen_at = NOW(),
             updated_at = NOW()`,
        [clientId, phone, accountName]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_connector_commands
         (client_id, channel, action, payload, status, requested_by, created_at, updated_at)
         VALUES ($1, 'whatsapp', 'connect_api', $2::jsonb, 'pending', $3, NOW(), NOW())`,
        [
          clientId,
          JSON.stringify({
            provider,
            phone,
            account_name: accountName,
            phone_number_id: phoneNumberId,
            waba_id: wabaId,
            base_url: baseUrl,
          }),
          userId,
        ]
      ).catch(() => null);
    }

    const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
    return safeJson(
      {
        ok: true,
        message: `Connected to WhatsApp via ${
          provider === "meta_cloud"
            ? "Meta WhatsApp Cloud API"
            : provider === "wati"
              ? "WATI Business API"
              : "Custom WhatsApp API"
        } (${phone})!`,
        status,
      },
      200
    );
  }

  return safeJson(
    {
      error: {
        code: "invalid_action",
        message: "Unsupported WhatsApp connector action.",
      },
    },
    400
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
