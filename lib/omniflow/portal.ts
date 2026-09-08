import "server-only";

import { ControlPlaneRequestError } from "./control-plane";
import { readSessionCookies } from "./session-cookies";


const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Tenant-scoped portal API layer.
 *
 * Every function talks to the Control Plane with the customer's Bearer token
 * and returns a NORMALIZED shape. If the Control Plane module is not deployed
 * yet (404/501) the result is `{ configured: false, ...defaults }` so the UI
 * can render a graceful pending state and light up automatically later —
 * no frontend changes needed when the backend endpoint ships.
 */

function controlPlaneBaseUrl(): URL {
  const raw = process.env.OMNIFLOW_CONTROL_PLANE_URL?.trim();
  if (!raw) throw new ControlPlaneRequestError(503, "control_plane_not_configured");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ControlPlaneRequestError(503, "control_plane_url_invalid");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new ControlPlaneRequestError(503, "control_plane_tls_required");
  }

  url.pathname = url.pathname.replace(/\/$/, "") + "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function portalRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = new URL(path.replace(/^\//, ""), controlPlaneBaseUrl());
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_unavailable");
  }
  return response;
}

/** Throws on auth failure so routes can trigger the refresh flow. */
function assertNotAuthError(error: unknown): void {
  if (error instanceof ControlPlaneRequestError && error.isUnauthorized) throw error;
}

// ---------------------------------------------------------------------------
// WhatsApp channel
// ---------------------------------------------------------------------------

export interface WhatsAppChannelStatus {
  /** false = Control Plane connector module not deployed yet. */
  configured: boolean;
  state: "disconnected" | "connecting" | "connected" | "unknown";
  accountName: string | null;
  phone: string | null;
  lastSeenAt: string | null;
}

const WHATSAPP_DISCONNECTED: WhatsAppChannelStatus = {
  configured: false,
  state: "disconnected",
  accountName: null,
  phone: null,
  lastSeenAt: null,
};

export async function getWhatsAppChannelStatus(
  accessToken: string
): Promise<WhatsAppChannelStatus> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/channels/whatsapp");
  } catch (error) {
    assertNotAuthError(error);
    return WHATSAPP_DISCONNECTED;
  }

  if (response.status === 404 || response.status === 501) {
    return WHATSAPP_DISCONNECTED;
  }
  if (!response.ok) {
    if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
    return WHATSAPP_DISCONNECTED;
  }

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { ...WHATSAPP_DISCONNECTED, state: "unknown" };
  }
  const p = payload as Record<string, unknown>;
  const rawState = typeof p.state === "string" ? p.state : "unknown";
  const allowedStates: readonly string[] = ["disconnected", "connecting", "connected"];
  const state = allowedStates.includes(rawState)
    ? (rawState as WhatsAppChannelStatus["state"])
    : "unknown";

  return {
    configured: true,
    state,
    accountName: typeof p.account_name === "string" ? p.account_name : null,
    phone: typeof p.phone === "string" ? p.phone : null,
    lastSeenAt: typeof p.last_seen_at === "string" ? p.last_seen_at : null,
  };
}

export type WhatsAppChannelAction = "connect" | "disconnect";

export interface WhatsAppActionResult {
  ok: boolean;
  configured: boolean;
  message: string | null;
}

export async function requestWhatsAppAction(
  accessToken: string,
  action: WhatsAppChannelAction
): Promise<WhatsAppActionResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, configured: false, message: null };
  }

  if (response.status === 404 || response.status === 501) {
    return { ok: false, configured: false, message: null };
  }
  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) {
    return { ok: false, configured: true, message: "The connector rejected this action." };
  }

  const payload: unknown = await response.json().catch(() => null);
  let message: string | null = null;
  if (payload !== null && typeof payload === "object") {
    const raw = (payload as Record<string, unknown>).message;
    if (typeof raw === "string") message = raw;
  }
  return { ok: true, configured: true, message };
}

// ---------------------------------------------------------------------------
// AI agent (bot) configuration
// ---------------------------------------------------------------------------

export interface BotConfig {
  configured: boolean;
  agentName: string;
  tone: "friendly" | "professional" | "concise";
  greeting: string;
  fallback: string;
  workingHoursEnabled: boolean;
  workingHoursStart: string;
  workingHoursEnd: string;
  humanHandoffEnabled: boolean;
  customInstructions: string;
  updatedAt: string | null;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  configured: false,
  agentName: "OmniFlow Assistant",
  tone: "friendly",
  greeting: "",
  fallback: "",
  workingHoursEnabled: false,
  workingHoursStart: "09:00",
  workingHoursEnd: "18:00",
  humanHandoffEnabled: false,
  customInstructions: "",
  updatedAt: null,
};

function normalizeBotConfig(payload: unknown): BotConfig {
  if (payload === null || typeof payload !== "object") return { ...DEFAULT_BOT_CONFIG };
  const p = payload as Record<string, unknown>;
  const tone = p.tone === "professional" || p.tone === "concise" ? p.tone : "friendly";
  return {
    configured: true,
    agentName: typeof p.agent_name === "string" ? p.agent_name : DEFAULT_BOT_CONFIG.agentName,
    tone,
    greeting: typeof p.greeting === "string" ? p.greeting : "",
    fallback: typeof p.fallback === "string" ? p.fallback : "",
    workingHoursEnabled: p.working_hours_enabled === true,
    workingHoursStart:
      typeof p.working_hours_start === "string" ? p.working_hours_start : "09:00",
    workingHoursEnd: typeof p.working_hours_end === "string" ? p.working_hours_end : "18:00",
    humanHandoffEnabled: p.human_handoff_enabled === true,
    customInstructions: typeof p.custom_instructions === "string" ? p.custom_instructions : "",
    updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
  };
}

export async function getBotConfig(accessToken: string): Promise<BotConfig> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/bot");
  } catch (error) {
    assertNotAuthError(error);
    return { ...DEFAULT_BOT_CONFIG };
  }

  if (response.status === 404 || response.status === 501) {
    return { ...DEFAULT_BOT_CONFIG };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { ...DEFAULT_BOT_CONFIG };

  return normalizeBotConfig(await response.json().catch(() => null));
}

function botConfigBody(config: BotConfig): Record<string, unknown> {
  return {
    agent_name: config.agentName,
    tone: config.tone,
    greeting: config.greeting,
    fallback: config.fallback,
    working_hours_enabled: config.workingHoursEnabled,
    working_hours_start: config.workingHoursStart,
    working_hours_end: config.workingHoursEnd,
    human_handoff_enabled: config.humanHandoffEnabled,
    custom_instructions: config.customInstructions,
  };
}

export async function saveBotConfig(
  accessToken: string,
  config: BotConfig
): Promise<{ ok: boolean; configured: boolean }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/bot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botConfigBody(config)),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, configured: false };
  }

  if (response.status === 404 || response.status === 501) {
    return { ok: false, configured: false };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, configured: true };
}

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

export interface BusinessProfileResult {
  configured: boolean;
  data: Record<string, string>;
  updatedAt: string | null;
}

export const DEFAULT_BUSINESS_PROFILE: Record<string, string> = {
  business_name: "",
  industry: "",
  phone: "",
  website: "",
  address: "",
  timezone: "Asia/Karachi",
  business_hours: "",
  default_language: "english",
};

export async function getBusinessProfile(
  accessToken: string
): Promise<BusinessProfileResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/profile");
  } catch (error) {
    assertNotAuthError(error);
    return { configured: false, data: {}, updatedAt: null };
  }

  if (response.status === 404 || response.status === 501) {
    return { configured: false, data: {}, updatedAt: null };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { configured: false, data: {}, updatedAt: null };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { configured: false, data: {}, updatedAt: null };
  }
  const p = payload as Record<string, unknown>;
  const rawProfile = p.profile;
  const data: Record<string, string> = {};
  if (rawProfile !== null && typeof rawProfile === "object") {
    for (const [key, value] of Object.entries(rawProfile as Record<string, unknown>)) {
      if (typeof value === "string") data[key] = value;
    }
  }
  return {
    configured: true,
    data,
    updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
  };
}

export interface SaveResult {
  ok: boolean;
  configured: boolean;
  message: string | null;
}

export async function saveBusinessProfile(
  accessToken: string,
  profile: Record<string, string>
): Promise<SaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, configured: false, message: null };
  }

  if (response.status === 404 || response.status === 501) {
    return { ok: false, configured: false, message: null };
  }
  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    let message: string | null = null;
    if (payload !== null && typeof payload === "object") {
      const rawError = (payload as Record<string, unknown>).error;
      if (rawError !== null && typeof rawError === "object") {
        const raw = (rawError as Record<string, unknown>).message;
        if (typeof raw === "string") message = raw;
      }
    }
    return { ok: false, configured: true, message };
  }
  return { ok: true, configured: true, message: null };
}

// ---------------------------------------------------------------------------
// Portal API key (ofk_…)
// ---------------------------------------------------------------------------

export interface ApiKeyResult {
  configured: boolean;
  keyPrefix: string | null;
  revoked: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

const NO_API_KEY: ApiKeyResult = {
  configured: false,
  keyPrefix: null,
  revoked: false,
  createdAt: null,
  lastUsedAt: null,
};

export async function getApiKeyInfo(accessToken: string): Promise<ApiKeyResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/api-key");
  } catch (error) {
    assertNotAuthError(error);
    return { ...NO_API_KEY };
  }

  if (response.status === 404 || response.status === 501) return { ...NO_API_KEY };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { ...NO_API_KEY };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { ...NO_API_KEY };
  const p = payload as Record<string, unknown>;
  if (p.configured !== true) return { ...NO_API_KEY };
  return {
    configured: true,
    keyPrefix: typeof p.key_prefix === "string" ? p.key_prefix : null,
    revoked: p.revoked === true,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    lastUsedAt: typeof p.last_used_at === "string" ? p.last_used_at : null,
  };
}

export async function rotateApiKey(
  accessToken: string
): Promise<{ ok: boolean; key: string | null; message: string | null }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/api-key/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, key: null, message: null };
  }

  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    let message: string | null = null;
    if (payload !== null && typeof payload === "object") {
      const rawError = (payload as Record<string, unknown>).error;
      if (rawError !== null && typeof rawError === "object") {
        const raw = (rawError as Record<string, unknown>).message;
        if (typeof raw === "string") message = raw;
      }
    }
    return { ok: false, key: null, message };
  }
  const payload: unknown = await response.json().catch(() => null);
  const key =
    payload !== null &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).key === "string"
      ? ((payload as Record<string, unknown>).key as string)
      : null;
  return { ok: key !== null, key, message: null };
}

export async function revokeApiKey(
  accessToken: string
): Promise<{ ok: boolean; message: string | null }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/api-key/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, message: null };
  }

  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) return { ok: false, message: "The key could not be revoked." };
  return { ok: true, message: null };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string | null;
  unread: boolean;
  lastIntent: string | null;
}

export interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  intent: string | null;
  createdAt: string | null;
}

function normalizeConversation(value: unknown): ConversationSummary | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    channel: typeof p.channel === "string" ? p.channel : "whatsapp",
    contactId: typeof p.contact_id === "string" ? p.contact_id : null,
    contactName: typeof p.contact_name === "string" ? p.contact_name : null,
    status: typeof p.status === "string" ? p.status : "open",
    lastMessageAt: typeof p.last_message_at === "string" ? p.last_message_at : null,
    lastMessagePreview:
      typeof p.last_message_preview === "string" ? p.last_message_preview : null,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    unread: p.unread === true,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,
  };
}

export async function listConversations(
  accessToken: string,
  searchQuery?: string,
  statusFilter?: string,
  intentFilter?: string
): Promise<ConversationSummary[] | null> {
  const searchPart =
    searchQuery && searchQuery.trim()
      ? "q=" + encodeURIComponent(searchQuery.trim().slice(0, 100))
      : "";
  const statusPart =
    statusFilter && statusFilter !== "all"
      ? "status=" + encodeURIComponent(statusFilter)
      : "";
  const intentPart =
    intentFilter && intentFilter !== "all"
      ? "intent=" + encodeURIComponent(intentFilter)
      : "";
  const parts = [searchPart, statusPart, intentPart].filter(Boolean);
  const query = parts.length ? "?" + parts.join("&") : "";
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).conversations;
  if (!Array.isArray(rawList)) return null;
  const conversations: ConversationSummary[] = [];
  for (const item of rawList) {
    const normalized = normalizeConversation(item);
    if (normalized) conversations.push(normalized);
  }
  return conversations;
}

export type ConversationDetailResult =
  | { kind: "ok"; conversation: ConversationSummary; messages: ConversationMessage[] }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function getConversation(
  accessToken: string,
  conversationId: number
): Promise<ConversationDetailResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + encodeURIComponent(String(conversationId))
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  const conversation = normalizeConversation(p.conversation);
  if (!conversation) return { kind: "unavailable" };
  const rawMessages = Array.isArray(p.messages) ? p.messages : [];
  const messages: ConversationMessage[] = [];
  for (const item of rawMessages) {
    if (item === null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    messages.push({
      id: typeof m.id === "number" ? m.id : 0,
      direction: m.direction === "out" ? "out" : "in",
      body: typeof m.body === "string" ? m.body : "",
      status: typeof m.status === "string" ? m.status : "delivered",
      intent: typeof m.intent === "string" ? m.intent : null,
      createdAt: typeof m.created_at === "string" ? m.created_at : null,
    });
  }
  return { kind: "ok", conversation, messages };
}

export interface IntentSummaryEntry {
  intent: string;
  conversations: number;
}

export async function fetchIntentSummary(
  accessToken: string
): Promise<IntentSummaryEntry[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/intents/summary"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).intents;
  if (!Array.isArray(rawList)) return null;
  const entries: IntentSummaryEntry[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.intent !== "string") continue;
    entries.push({
      intent: entry.intent,
      conversations:
        typeof entry.conversations === "number" ? entry.conversations : 0,
    });
  }
  return entries;
}

export interface FollowupSettings {
  enabled: boolean;
  delayHours: number;
  maxAttempts: number;
  messageTemplate: string;
}

export async function getFollowupSettings(
  accessToken: string
): Promise<FollowupSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/followups");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).settings;
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  return {
    enabled: p.enabled === true,
    delayHours: typeof p.delay_hours === "number" ? p.delay_hours : 24,
    maxAttempts: typeof p.max_attempts === "number" ? p.max_attempts : 2,
    messageTemplate: typeof p.message_template === "string" ? p.message_template : "",
  };
}

export async function saveFollowupSettings(
  accessToken: string,
  settings: FollowupSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/followups", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          enabled: settings.enabled,
          delay_hours: settings.delayHours,
          max_attempts: settings.maxAttempts,
          message_template: settings.messageTemplate,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface KbEntry {
  id: number;
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  usageCount: number;
}

export interface KbEntryInput {
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
}

export interface KbSettings {
  autoReply: boolean;
}

export interface KnowledgeBaseData {
  settings: KbSettings;
  entries: KbEntry[];
}

function mapKbEntry(raw: Record<string, unknown>): KbEntry {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    title: typeof raw.title === "string" ? raw.title : "",
    category: typeof raw.category === "string" ? raw.category : "general",
    keywords: typeof raw.keywords === "string" ? raw.keywords : "",
    content: typeof raw.content === "string" ? raw.content : "",
    isActive: raw.is_active === true,
    usageCount: typeof raw.usage_count === "number" ? raw.usage_count : 0,
  };
}

export async function getKnowledgeBase(
  accessToken: string
): Promise<KnowledgeBaseData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawSettings = p.settings;
  const rawEntries = p.entries;
  if (rawSettings === null || typeof rawSettings !== "object") return null;
  const settingsRaw = rawSettings as Record<string, unknown>;
  return {
    settings: { autoReply: settingsRaw.auto_reply === true },
    entries: Array.isArray(rawEntries)
      ? rawEntries
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map(mapKbEntry)
      : [],
  };
}

export async function createKbEntry(
  accessToken: string,
  entry: KbEntryInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: {
          title: entry.title,
          category: entry.category,
          keywords: entry.keywords,
          content: entry.content,
          is_active: entry.isActive,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function updateKbEntry(
  accessToken: string,
  entryId: number,
  entry: KbEntryInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/" + entryId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: {
            title: entry.title,
            category: entry.category,
            keywords: entry.keywords,
            content: entry.content,
            is_active: entry.isActive,
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteKbEntry(
  accessToken: string,
  entryId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/" + entryId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function saveKbSettings(
  accessToken: string,
  settings: KbSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          auto_reply: settings.autoReply,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export type ConversationStatusResult =
  | { kind: "ok"; conversation: ConversationSummary }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function updateConversationStatus(
  accessToken: string,
  conversationId: number,
  status: "open" | "closed"
): Promise<ConversationStatusResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + encodeURIComponent(String(conversationId)),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const conversation = normalizeConversation(
    (payload as Record<string, unknown>).conversation
  );
  if (!conversation) return { kind: "unavailable" };
  return { kind: "ok", conversation };
}

export type ConversationSendResult =
  | { kind: "ok"; queued: boolean; commandId: number | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function sendConversationMessage(
  accessToken: string,
  conversationId: number,
  body: string
): Promise<ConversationSendResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    queued: p.queued === true,
    commandId: typeof p.command_id === "number" ? p.command_id : null,
  };
}

// ---------------------------------------------------------------------------
// Session helper for BFF routes
// ---------------------------------------------------------------------------

export async function requirePortalAccessToken(): Promise<string | null> {
  const { accessToken } = await readSessionCookies();
  return accessToken ?? null;
}
