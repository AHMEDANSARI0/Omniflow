import { neonEnabled, neonQuery } from "../../../../../../lib/db/neon";
import { getOmniFlowSession } from "../../../../../../lib/omniflow/auth-dal";
import { getControlPlanePrincipal } from "../../../../../../lib/omniflow/control-plane";
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
import {
  disconnectBaileysSession,
  getBaileysMemorySnapshot,
  requestBaileysPairingCode,
  startBaileysQrSession,
} from "../../../../../../lib/omniflow/whatsapp-baileys";

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
  qrImageData: string | null;
  pairingCode: string | null;
  statusNote: string | null;
  apiConfig: WhatsAppApiConfigSummary;
}

type MemoryWhatsAppState = {
  state: "connected" | "connecting" | "disconnected";
  connectionMode: WhatsAppConnectionMode;
  accountName: string | null;
  phone: string | null;
  lastSeenAt: string | null;
  qrImageData: string | null;
  pairingCode: string | null;
  statusNote: string | null;
  apiConfig: WhatsAppApiConfigSummary & { accessToken?: string };
};

const globalForWa = globalThis as unknown as {
  __omniflowWaMem?: Map<number, MemoryWhatsAppState>;
  __omniflowWaSchemaV3Ready?: boolean;
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

function normalizeWhatsAppPhone(raw: string): string {
  const cleaned = raw.trim().replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  let digits = cleaned.replace(/\D/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 11) {
    digits = "92" + digits.slice(1);
  } else if (digits.startsWith("920") && digits.length === 13) {
    digits = "92" + digits.slice(3);
  } else if (digits.length === 10 && digits.startsWith("3")) {
    digits = "92" + digits;
  }
  return digits ? `+${digits}` : "";
}

async function ensureWhatsAppTables(): Promise<void> {
  if (!neonEnabled() || globalForWa.__omniflowWaSchemaV3Ready) return;
  try {
    await neonQuery(
      `CREATE TABLE IF NOT EXISTS portal_whatsapp_status (
         client_id BIGINT PRIMARY KEY,
         state TEXT NOT NULL DEFAULT 'disconnected',
         phone TEXT,
         account_name TEXT,
         last_seen_at TIMESTAMPTZ,
         reported_by BIGINT,
         qr_image_data TEXT,
         pairing_code TEXT,
         connection_mode TEXT NOT NULL DEFAULT 'none',
         status_note TEXT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await neonQuery(
      `ALTER TABLE portal_whatsapp_status ADD COLUMN IF NOT EXISTS qr_image_data TEXT`
    ).catch(() => null);
    await neonQuery(
      `ALTER TABLE portal_whatsapp_status ADD COLUMN IF NOT EXISTS pairing_code TEXT`
    ).catch(() => null);
    await neonQuery(
      `ALTER TABLE portal_whatsapp_status ADD COLUMN IF NOT EXISTS connection_mode TEXT NOT NULL DEFAULT 'none'`
    ).catch(() => null);
    await neonQuery(
      `ALTER TABLE portal_whatsapp_status ADD COLUMN IF NOT EXISTS status_note TEXT`
    ).catch(() => null);

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
    globalForWa.__omniflowWaSchemaV3Ready = true;
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
  const baileysSnap = getBaileysMemorySnapshot(clientId);

  let state: "connected" | "connecting" | "disconnected" =
    baileysSnap?.state || mem?.state || "disconnected";
  let connectionMode: WhatsAppConnectionMode =
    baileysSnap?.connectionMode || mem?.connectionMode || "none";
  let accountName: string | null =
    baileysSnap?.accountName || mem?.accountName || null;
  let phone: string | null = baileysSnap?.phone || mem?.phone || null;
  let lastSeenAt: string | null =
    baileysSnap?.lastSeenAt || mem?.lastSeenAt || null;
  let qrImageData: string | null =
    baileysSnap?.qrImageData || mem?.qrImageData || null;
  let pairingCode: string | null =
    baileysSnap?.pairingCode || mem?.pairingCode || null;
  let statusNote: string | null = null;
  let apiConfig: WhatsAppApiConfigSummary =
    mem?.apiConfig || defaultApiConfig(clientId);

  if (neonEnabled()) {
    await ensureWhatsAppTables();
    try {
      await neonQuery(
        `UPDATE portal_whatsapp_status
         SET state = 'disconnected', phone = NULL, status_note = NULL, updated_at = NOW()
         WHERE client_id = $1 AND phone = '+923001234567'`,
        [clientId]
      ).catch(() => null);

      await neonQuery(
        `UPDATE portal_whatsapp_status
         SET status_note = NULL
         WHERE client_id = $1 AND status_note ILIKE '%playwright%'`,
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
        qr_image_data: string | null;
        pairing_code: string | null;
        connection_mode: string | null;
        status_note: string | null;
      }>(
        `SELECT state, phone, account_name, last_seen_at,
                qr_image_data, pairing_code, connection_mode, status_note
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
        const dbModeRaw = row.connection_mode || "none";
        const dbMode: WhatsAppConnectionMode =
          dbModeRaw === "qr" ||
          dbModeRaw === "pairing_code" ||
          dbModeRaw === "meta_cloud" ||
          dbModeRaw === "wati" ||
          dbModeRaw === "custom_api"
            ? dbModeRaw
            : "none";

        qrImageData = row.qr_image_data || qrImageData;
        pairingCode = row.pairing_code || pairingCode;
        const cleanNote =
          row.status_note && !/playwright/i.test(row.status_note)
            ? row.status_note
            : null;
        statusNote = cleanNote;

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
          connectionMode = dbMode !== "none" ? dbMode : "qr";
          phone = dbPhone;
          accountName = row.account_name || null;
          lastSeenAt = row.last_seen_at
            ? new Date(row.last_seen_at).toISOString()
            : null;
        } else if (rawState === "connecting") {
          state = "connecting";
          connectionMode = dbMode !== "none" ? dbMode : "qr";
          phone = dbPhone;
          accountName = row.account_name || null;
          lastSeenAt = row.last_seen_at
            ? new Date(row.last_seen_at).toISOString()
            : null;
        } else if (baileysSnap?.state !== "connected" && baileysSnap?.state !== "connecting") {
          state = "disconnected";
          connectionMode = "none";
          phone = null;
          qrImageData = null;
          pairingCode = null;
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
    qrImageData,
    pairingCode,
    statusNote,
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
    qrImageData: null,
    pairingCode: null,
    statusNote: null,
    apiConfig: defaultApiConfig(clientId),
  };

  await ensureWhatsAppTables();

  // 1. DISCONNECT WHATSAPP
  if (action === "disconnect") {
    await disconnectBaileysSession(clientId);

    currentMem.state = "disconnected";
    currentMem.connectionMode = "none";
    currentMem.phone = null;
    currentMem.qrImageData = null;
    currentMem.pairingCode = null;
    currentMem.statusNote = null;
    currentMem.apiConfig = {
      ...currentMem.apiConfig,
      enabled: false,
    };
    memMap.set(clientId, currentMem);

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_status
         (client_id, state, connection_mode, phone, qr_image_data, pairing_code, status_note, last_seen_at, updated_at)
         VALUES ($1, 'disconnected', 'none', NULL, NULL, NULL, NULL, NOW(), NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'disconnected',
             connection_mode = 'none',
             phone = NULL,
             qr_image_data = NULL,
             pairing_code = NULL,
             status_note = NULL,
             updated_at = NOW()`,
        [clientId]
      ).catch(() => null);

      await neonQuery(
        `UPDATE portal_whatsapp_api_configs
         SET enabled = FALSE, updated_at = NOW()
         WHERE client_id = $1`,
        [clientId]
      ).catch(() => null);

      await neonQuery(
        `UPDATE portal_connector_commands
         SET status = 'cancelled', updated_at = NOW()
         WHERE client_id = $1 AND status = 'pending'`,
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
        message: "WhatsApp disconnected.",
        status,
      },
      200
    );
  }

  // 2. START REAL WHATSAPP WEB MULTI-DEVICE QR SESSION
  if (action === "start_qr" || action === "connect") {
    const accountLabel =
      typeof payload.accountName === "string" && payload.accountName.trim()
        ? payload.accountName.trim().slice(0, 80)
        : currentMem.accountName || `Workspace #${clientId} WhatsApp`;

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_status
         (client_id, state, connection_mode, account_name, qr_image_data, pairing_code, status_note, updated_at)
         VALUES ($1, 'connecting', 'qr', $2, NULL, NULL, NULL, NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'connecting',
             connection_mode = 'qr',
             account_name = COALESCE(EXCLUDED.account_name, portal_whatsapp_status.account_name),
             qr_image_data = NULL,
             pairing_code = NULL,
             status_note = NULL,
             updated_at = NOW()`,
        [clientId, accountLabel]
      ).catch(() => null);

      await neonQuery(
        `INSERT INTO portal_connector_commands
         (client_id, channel, action, payload, status, requested_by, created_at, updated_at)
         VALUES ($1, 'whatsapp', 'start_qr', $2::jsonb, 'pending', $3, NOW(), NOW())`,
        [clientId, JSON.stringify({ account_name: accountLabel }), userId]
      ).catch(() => null);
    }

    const baileysSnap = await startBaileysQrSession(clientId, accountLabel);
    currentMem.state = baileysSnap.state;
    currentMem.connectionMode = "qr";
    currentMem.accountName = accountLabel;
    currentMem.qrImageData = baileysSnap.qrImageData;
    currentMem.pairingCode = null;
    currentMem.statusNote = null;
    memMap.set(clientId, currentMem);

    const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
    return safeJson(
      {
        ok: true,
        message: status.qrImageData
          ? "Official WhatsApp Web QR code is ready. Scan it with your phone."
          : "Generating official WhatsApp Web QR code…",
        status,
      },
      200
    );
  }

  // 3. REQUEST OFFICIAL 8-CHARACTER PAIRING CODE ("Link with phone number instead")
  if (action === "request_pairing_code") {
    const rawPhone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const normalizedPhone = normalizeWhatsAppPhone(rawPhone);
    if (normalizedPhone.length < 9) {
      return safeJson(
        {
          error: {
            code: "invalid_phone",
            message:
              "Please enter a valid WhatsApp phone number with country code (e.g. +92 331 3194929).",
          },
        },
        400
      );
    }

    const accountLabel =
      typeof payload.accountName === "string" && payload.accountName.trim()
        ? payload.accountName.trim().slice(0, 80)
        : currentMem.accountName || `WhatsApp (${normalizedPhone})`;

    if (neonEnabled()) {
      await neonQuery(
        `INSERT INTO portal_whatsapp_status
         (client_id, state, connection_mode, phone, account_name, qr_image_data, pairing_code, status_note, updated_at)
         VALUES ($1, 'connecting', 'pairing_code', $2, $3, NULL, NULL, NULL, NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'connecting',
             connection_mode = 'pairing_code',
             phone = EXCLUDED.phone,
             account_name = EXCLUDED.account_name,
             qr_image_data = NULL,
             pairing_code = NULL,
             status_note = NULL,
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
          }),
          userId,
        ]
      ).catch(() => null);
    }

    const baileysSnap = await requestBaileysPairingCode(
      clientId,
      normalizedPhone,
      accountLabel
    );
    currentMem.state = baileysSnap.state;
    currentMem.connectionMode = "pairing_code";
    currentMem.phone = normalizedPhone;
    currentMem.accountName = accountLabel;
    currentMem.pairingCode = baileysSnap.pairingCode;
    currentMem.qrImageData = null;
    currentMem.statusNote = null;
    memMap.set(clientId, currentMem);

    const status = await readWorkspaceWhatsAppStatus(clientId, accessToken);
    return safeJson(
      {
        ok: true,
        message: status.pairingCode
          ? `Official WhatsApp linking code (${status.pairingCode}) generated for ${normalizedPhone}.`
          : `Requesting official linking code for ${normalizedPhone}…`,
        status,
      },
      200
    );
  }

  // 4. CONNECT VIA WHATSAPP BUSINESS API (Meta Cloud API / WATI / Custom API)
  if (action === "connect_api") {
    const providerRaw =
      typeof payload.provider === "string" ? payload.provider : "meta_cloud";
    const provider: "meta_cloud" | "wati" | "custom_api" =
      providerRaw === "wati" || providerRaw === "custom_api"
        ? providerRaw
        : "meta_cloud";

    const phone =
      typeof payload.phone === "string"
        ? normalizeWhatsAppPhone(payload.phone)
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

    if (!phone || phone.length < 9) {
      return safeJson(
        {
          error: {
            code: "invalid_phone",
            message:
              "Please provide your WhatsApp Business phone number with country code (e.g. +923313194929).",
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
    currentMem.qrImageData = null;
    currentMem.pairingCode = null;
    currentMem.statusNote = null;
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
        `INSERT INTO portal_whatsapp_status
         (client_id, state, connection_mode, phone, account_name, qr_image_data, pairing_code, status_note, last_seen_at, updated_at)
         VALUES ($1, 'connected', $2, $3, $4, NULL, NULL, NULL, NOW(), NOW())
         ON CONFLICT (client_id) DO UPDATE
         SET state = 'connected',
             connection_mode = EXCLUDED.connection_mode,
             phone = EXCLUDED.phone,
             account_name = EXCLUDED.account_name,
             qr_image_data = NULL,
             pairing_code = NULL,
             status_note = NULL,
             last_seen_at = NOW(),
             updated_at = NOW()`,
        [clientId, provider, phone, accountName]
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
        message: `Connected via ${
          provider === "meta_cloud"
            ? "Meta WhatsApp Cloud API"
            : provider === "wati"
              ? "WATI Business API"
              : "Custom WhatsApp API"
        } (${phone}).`,
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
