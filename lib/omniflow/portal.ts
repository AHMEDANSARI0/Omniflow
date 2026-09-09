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
  leadScore: number;
  leadTemp: string;
  assignedTo: string | null;
  assigneeName: string | null;
  tags: string[];
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
    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
    tags: Array.isArray(p.tags)
      ? p.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}

export async function listConversations(
  accessToken: string,
  searchQuery?: string,
  statusFilter?: string,
  intentFilter?: string,
  channelFilter?: string,
  tagFilter?: string
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
  const channelPart =
    channelFilter && channelFilter !== "all"
      ? "channel=" + encodeURIComponent(channelFilter)
      : "";
  const tagPart =
    tagFilter && tagFilter !== "all" ? "tag=" + encodeURIComponent(tagFilter) : "";
  const parts = [searchPart, statusPart, intentPart, channelPart, tagPart].filter(
    Boolean
  );
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

export interface CatalogItem {
  id: number;
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
}

export interface CatalogItemInput {
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
}

export interface IndustryPreset {
  id: string;
  label: string;
  description: string;
  entryCount: number;
}

export interface ActivityItem {
  id: number;
  action: string;
  label: string;
  note: string;
  createdAt: string;
  timeAgo: string;
}

function mapCatalogItem(raw: Record<string, unknown>): CatalogItem {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    kind: raw.kind === "service" ? "service" : "product",
    name: typeof raw.name === "string" ? raw.name : "",
    priceText: typeof raw.price_text === "string" ? raw.price_text : "",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    isActive: raw.is_active === true,
  };
}

export async function getCatalog(
  accessToken: string
): Promise<{ items: CatalogItem[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/catalog");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return { items: [] };
  return {
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map(mapCatalogItem),
  };
}

export async function createCatalogItem(
  accessToken: string,
  item: CatalogItemInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          kind: item.kind,
          name: item.name,
          price_text: item.priceText,
          notes: item.notes,
          is_active: item.isActive,
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

export async function updateCatalogItem(
  accessToken: string,
  itemId: number,
  item: CatalogItemInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/catalog/" + itemId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: {
            kind: item.kind,
            name: item.name,
            price_text: item.priceText,
            notes: item.notes,
            is_active: item.isActive,
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

export async function deleteCatalogItem(
  accessToken: string,
  itemId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/catalog/" + itemId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getIndustryPresets(
  accessToken: string
): Promise<{ presets: IndustryPreset[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/presets");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawPresets = (payload as Record<string, unknown>).presets;
  if (!Array.isArray(rawPresets)) return { presets: [] };
  return {
    presets: rawPresets
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        id: typeof raw.id === "string" ? raw.id : "",
        label: typeof raw.label === "string" ? raw.label : "",
        description: typeof raw.description === "string" ? raw.description : "",
        entryCount: typeof raw.entryCount === "number" ? raw.entryCount : 0,
      })),
  };
}

export async function applyIndustryPreset(
  accessToken: string,
  industry: string
): Promise<
  | { kind: "ok"; applied: number; skipped: number }
  | { kind: "bad_request" }
  | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/presets/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ industry }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "bad_request" };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    applied: typeof p.applied === "number" ? p.applied : 0,
    skipped: typeof p.skipped === "number" ? p.skipped : 0,
  };
}

const ACTION_LABELS: Record<string, string> = {
  "kb.auto_reply": "Instant answer sent",
  "message.enqueued": "Reply queued",
  "conversation.status_changed": "Conversation status changed",
  "followup.ack": "Follow-up delivered",
  "preset.applied": "Starter pack loaded",
  "catalog.changed": "Catalog updated",
};

function timeAgoLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

export async function getRecentActivity(
  accessToken: string
): Promise<ActivityItem[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/activity");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object"
    )
    .map((raw) => {
      const action = typeof raw.action === "string" ? raw.action : "";
      const createdAt =
        typeof raw.created_at === "string" ? raw.created_at : "";
      return {
        id: typeof raw.id === "number" ? raw.id : 0,
        action,
        label: ACTION_LABELS[action] || action,
        note: typeof raw.note === "string" ? raw.note : "",
        createdAt,
        timeAgo: timeAgoLabel(createdAt),
      };
    });
}

export interface AnalyticsTotals {
  conversations: number;
  conversationsClosed: number;
  customers: number;
  messagesIn: number;
  messagesOut: number;
}

export interface AnalyticsWindow {
  conversations: number;
  messagesIn: number;
  messagesOut: number;
  instantAnswers: number;
  followupsDelivered: number;
  repliesQueued: number;
}

export interface AnalyticsDayPoint {
  day: string;
  inbound: number;
  outbound: number;
}

export interface AnalyticsIntent {
  intent: string;
  count: number;
}

export interface AnalyticsTopEntry {
  title: string;
  usageCount: number;
}

export interface AnalyticsData {
  days: number;
  totals: AnalyticsTotals;
  window: AnalyticsWindow;
  perDay: AnalyticsDayPoint[];
  intents: AnalyticsIntent[];
  topEntries: AnalyticsTopEntry[];
}

export async function getAnalytics(
  accessToken: string,
  path = "api/v1/portal/analytics"
): Promise<AnalyticsData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path);
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawTotals = p.totals;
  const rawWindow = p.window;
  const rawPerDay = p.per_day;
  const rawIntents = p.intents;
  const rawTopEntries = p.top_entries;
  if (
    rawTotals === null || typeof rawTotals !== "object" ||
    rawWindow === null || typeof rawWindow !== "object" ||
    !Array.isArray(rawPerDay)
  ) {
    return null;
  }
  const t = rawTotals as Record<string, unknown>;
  const w = rawWindow as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    days: num(p.days) || 7,
    totals: {
      conversations: num(t.conversations),
      conversationsClosed: num(t.conversations_closed),
      customers: num(t.customers),
      messagesIn: num(t.messages_in),
      messagesOut: num(t.messages_out),
    },
    window: {
      conversations: num(w.conversations),
      messagesIn: num(w.messages_in),
      messagesOut: num(w.messages_out),
      instantAnswers: num(w.instant_answers),
      followupsDelivered: num(w.followups_delivered),
      repliesQueued: num(w.replies_queued),
    },
    perDay: rawPerDay
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        day: typeof raw.day === "string" ? raw.day : "",
        inbound: num(raw.inbound),
        outbound: num(raw.outbound),
      })),
    intents: Array.isArray(rawIntents)
      ? rawIntents
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map((raw) => ({
            intent: typeof raw.intent === "string" ? raw.intent : "",
            count: num(raw.count),
          }))
      : [],
    topEntries: Array.isArray(rawTopEntries)
      ? rawTopEntries
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map((raw) => ({
            title: typeof raw.title === "string" ? raw.title : "",
            usageCount: num(raw.usage_count),
          }))
      : [],
  };
}

export interface CodConfirmation {
  id: number;
  status: string;
  details: string;
  attempts: number;
  createdAt: string | null;
  answeredAt: string | null;
}

export interface OrderRow {
  id: number;
  code: string;
  statusText: string;
  note: string;
  updatedAt: string | null;
}

export interface OrderImportItem {
  code: string;
  status: string;
  note: string;
}

export async function getConversationCod(
  accessToken: string,
  conversationId: number
): Promise<{ cod: CodConfirmation | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/cod"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).cod;
  if (raw === null || raw === undefined) return { cod: null };
  if (typeof raw !== "object") return { cod: null };
  const p = raw as Record<string, unknown>;
  return {
    cod: {
      id: typeof p.id === "number" ? p.id : 0,
      status: typeof p.status === "string" ? p.status : "pending",
      details: typeof p.details === "string" ? p.details : "",
      attempts: typeof p.attempts === "number" ? p.attempts : 1,
      createdAt: typeof p.created_at === "string" ? p.created_at : null,
      answeredAt: typeof p.answered_at === "string" ? p.answered_at : null,
    },
  };
}

export async function requestCodConfirmation(
  accessToken: string,
  conversationId: number,
  details: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/cod",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ details }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function listOrders(
  accessToken: string
): Promise<{ items: OrderRow[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/orders");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return { items: [] };
  return {
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        id: typeof raw.id === "number" ? raw.id : 0,
        code: typeof raw.code === "string" ? raw.code : "",
        statusText: typeof raw.status_text === "string" ? raw.status_text : "",
        note: typeof raw.note === "string" ? raw.note : "",
        updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
      })),
  };
}

export async function importOrders(
  accessToken: string,
  items: OrderImportItem[]
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/orders/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteOrder(
  accessToken: string,
  orderId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/orders/" + orderId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Team (multi-user roles, assignment) + internal conversation notes
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "admin" | "agent";

export interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: TeamRole;
  status: string;
  createdAt: string | null;
}

export interface TeamOverview {
  members: TeamMember[];
  myRole: TeamRole | null;
}

export interface NoteEntry {
  id: number;
  authorEmail: string;
  authorName: string;
  body: string;
  createdAt: string | null;
}

export type TeamMutationResult =
  | { kind: "ok"; member: TeamMember | null }
  | { kind: "forbidden" }
  | { kind: "exists" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export type AssignConversationResult =
  | { kind: "ok"; assignedTo: string | null; assigneeName: string | null }
  | { kind: "not_found" }
  | { kind: "assignee_not_found" }
  | { kind: "unavailable" };

export type NoteAddResult =
  | { kind: "ok"; note: NoteEntry | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeTeamMember(value: unknown): TeamMember | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const email = typeof p.email === "string" ? p.email : "";
  if (id === null || !email) return null;
  const role: TeamRole = p.role === "owner" || p.role === "admin" ? p.role : "agent";
  return {
    id,
    email,
    name: typeof p.name === "string" ? p.name : "",
    role,
    status: p.status === "disabled" ? "disabled" : "active",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

function normalizeNoteEntry(value: unknown): NoteEntry | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    authorEmail: typeof p.author_email === "string" ? p.author_email : "",
    authorName: typeof p.author_name === "string" ? p.author_name : "",
    body: typeof p.body === "string" ? p.body : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listTeam(
  accessToken: string
): Promise<TeamOverview | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/team");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawMembers = Array.isArray(p.members) ? p.members : [];
  const members: TeamMember[] = [];
  for (const raw of rawMembers) {
    const member = normalizeTeamMember(raw);
    if (member) members.push(member);
  }
  const myRole =
    p.my_role === "owner" || p.my_role === "admin" || p.my_role === "agent"
      ? p.my_role
      : null;
  return { members, myRole };
}

async function teamMutation(
  accessToken: string,
  path: string,
  init: RequestInit
): Promise<TeamMutationResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path, init);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 409) return { kind: "exists" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "ok", member: null };
  }
  const member = normalizeTeamMember(
    (payload as Record<string, unknown>).member
  );
  return { kind: "ok", member };
}

export async function addTeamMember(
  accessToken: string,
  email: string,
  name: string,
  role: "admin" | "agent"
): Promise<TeamMutationResult> {
  return teamMutation(accessToken, "api/v1/portal/team", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name, role }),
  });
}

export async function updateTeamMember(
  accessToken: string,
  memberId: number,
  patch: { role?: string; status?: string }
): Promise<TeamMutationResult> {
  return teamMutation(
    accessToken,
    "api/v1/portal/team/" + encodeURIComponent(String(memberId)),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
}

export async function removeTeamMember(
  accessToken: string,
  memberId: number
): Promise<TeamMutationResult> {
  return teamMutation(
    accessToken,
    "api/v1/portal/team/" + encodeURIComponent(String(memberId)),
    { method: "DELETE" }
  );
}

export async function assignConversation(
  accessToken: string,
  conversationId: number,
  assigneeEmail: string | null
): Promise<AssignConversationResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/assign",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_email: assigneeEmail }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).error
        : null;
    const errorCode =
      code !== null && typeof code === "object"
        ? (code as Record<string, unknown>).code
        : null;
    if (errorCode === "assignee_not_found") return { kind: "assignee_not_found" };
    return { kind: "not_found" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "unavailable" };
  }
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
  };
}

export async function listConversationNotes(
  accessToken: string,
  conversationId: number
): Promise<{ notes: NoteEntry[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/notes"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawNotes = (payload as Record<string, unknown>).notes;
  if (!Array.isArray(rawNotes)) return { notes: [] };
  const notes: NoteEntry[] = [];
  for (const raw of rawNotes) {
    const note = normalizeNoteEntry(raw);
    if (note) notes.push(note);
  }
  return { notes };
}

export async function addConversationNote(
  accessToken: string,
  conversationId: number,
  body: string
): Promise<NoteAddResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/notes",
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

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "ok", note: null };
  }
  const note = normalizeNoteEntry((payload as Record<string, unknown>).note);
  return { kind: "ok", note };
}

// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------

export type BroadcastAudience = "all" | "open" | "hot";

export interface BroadcastPreview {
  audience: BroadcastAudience;
  count: number;
  sample: string[];
}

export interface BroadcastRow {
  id: number;
  audience: BroadcastAudience;
  body: string;
  recipientCount: number;
  createdAt: string | null;
  queued: number | null;
  done: number | null;
  failed: number | null;
}

export interface CsatRequest {
  id: number;
  score: number | null;
  requestedAt: string | null;
  answeredAt: string | null;
}

export interface CsatSummary {
  average: number | null;
  total: number;
  pending: number;
  dist: number[];
}

export interface KbGap {
  id: number;
  conversationId: number;
  question: string;
  intent: string;
  resolved: boolean;
  createdAt: string | null;
}

function normalizeBroadcast(value: unknown): BroadcastRow | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  const audience: BroadcastAudience =
    p.audience === "open" || p.audience === "hot" ? p.audience : "all";
  return {
    id,
    audience,
    body: typeof p.body === "string" ? p.body : "",
    recipientCount: typeof p.recipient_count === "number" ? p.recipient_count : 0,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    queued: typeof p.queued === "number" ? p.queued : null,
    done: typeof p.done === "number" ? p.done : null,
    failed: typeof p.failed === "number" ? p.failed : null,
  };
}

export async function listBroadcasts(
  accessToken: string
): Promise<{ broadcasts: BroadcastRow[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).broadcasts;
  if (!Array.isArray(rawItems)) return { broadcasts: [] };
  const broadcasts: BroadcastRow[] = [];
  for (const raw of rawItems) {
    const row = normalizeBroadcast(raw);
    if (row) broadcasts.push(row);
  }
  return { broadcasts };
}

export async function previewBroadcast(
  accessToken: string,
  audience: BroadcastAudience
): Promise<BroadcastPreview | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/broadcasts/preview?audience=" + encodeURIComponent(audience)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    audience:
      p.audience === "open" || p.audience === "hot"
        ? p.audience
        : "all",
    count: typeof p.count === "number" ? p.count : 0,
    sample: Array.isArray(p.sample)
      ? p.sample.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export type BroadcastSendResult =
  | { kind: "ok"; broadcast: BroadcastRow; recipients: number }
  | { kind: "no_recipients" }
  | { kind: "too_many" }
  | { kind: "unavailable" };

export async function sendBroadcast(
  accessToken: string,
  audience: BroadcastAudience,
  body: string
): Promise<BroadcastSendResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience, body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? ((payload as Record<string, unknown>).error as Record<string, unknown> | undefined)
            ?.code
        : null;
    if (code === "no_recipients") return { kind: "no_recipients" };
    if (code === "too_many_recipients") return { kind: "too_many" };
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  const broadcast = normalizeBroadcast(p.broadcast);
  if (!broadcast) return { kind: "unavailable" };
  return {
    kind: "ok",
    broadcast,
    recipients: typeof p.recipients === "number" ? p.recipients : broadcast.recipientCount,
  };
}

export type CsatRequestResult =
  | { kind: "ok"; csat: CsatRequest }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeCsat(value: unknown): CsatRequest | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    score: typeof p.score === "number" ? p.score : null,
    requestedAt: typeof p.requested_at === "string" ? p.requested_at : null,
    answeredAt: typeof p.answered_at === "string" ? p.answered_at : null,
  };
}

export async function requestCsat(
  accessToken: string,
  conversationId: number
): Promise<CsatRequestResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/csat",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const csat = normalizeCsat((payload as Record<string, unknown>).csat);
  if (!csat) return { kind: "unavailable" };
  return { kind: "ok", csat };
}

export async function getConversationCsat(
  accessToken: string,
  conversationId: number
): Promise<{ csat: CsatRequest | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/csat"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { csat: null };
  return { csat: normalizeCsat((payload as Record<string, unknown>).csat) };
}

export async function getCsatSummary(
  accessToken: string
): Promise<CsatSummary | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/csat/summary");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawDist = Array.isArray(p.dist) ? p.dist : [];
  const dist = [0, 1, 2, 3, 4].map(
    (index) => (typeof rawDist[index] === "number" ? rawDist[index] : 0) as number
  );
  return {
    average: typeof p.average === "number" ? p.average : null,
    total: typeof p.total === "number" ? p.total : 0,
    pending: typeof p.pending === "number" ? p.pending : 0,
    dist,
  };
}

export async function listKbGaps(
  accessToken: string,
  status: "open" | "all" = "open"
): Promise<{ gaps: KbGap[]; openCount: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/gaps?status=" + encodeURIComponent(status)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawGaps = Array.isArray(p.gaps) ? p.gaps : [];
  const gaps: KbGap[] = [];
  for (const raw of rawGaps) {
    if (raw === null || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const id = typeof g.id === "number" ? g.id : null;
    if (id === null) continue;
    gaps.push({
      id,
      conversationId: typeof g.conversation_id === "number" ? g.conversation_id : 0,
      question: typeof g.question === "string" ? g.question : "",
      intent: typeof g.intent === "string" ? g.intent : "general",
      resolved: g.resolved === true || g.resolved === 1,
      createdAt: typeof g.created_at === "string" ? g.created_at : null,
    });
  }
  return {
    gaps,
    openCount: typeof p.open_count === "number" ? p.open_count : 0,
  };
}

export async function resolveKbGap(
  accessToken: string,
  gapId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/gaps/" + encodeURIComponent(String(gapId)),
      { method: "PATCH" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Website widget settings
// ---------------------------------------------------------------------------

export interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
  accent: string;
  position: "left" | "right";
  launcherLabel: string;
}

function normalizeWidgetSettings(value: unknown): WidgetSettings | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const settings = (p.settings !== undefined ? p.settings : p) as Record<string, unknown>;
  return {
    enabled: settings.enabled === true,
    businessName:
      typeof settings.business_name === "string" ? settings.business_name : "",
    welcomeText:
      typeof settings.welcome_text === "string" ? settings.welcome_text : "",
    accent:
      typeof settings.accent === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(settings.accent)
        ? settings.accent
        : "#22d3ee",
    position: settings.position === "left" ? "left" : "right",
    launcherLabel:
      typeof settings.launcher_label === "string" ? settings.launcher_label : "",
  };
}

export async function getWidgetSettings(
  accessToken: string
): Promise<WidgetSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/widget/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return normalizeWidgetSettings(payload);
}

export async function saveWidgetSettings(
  accessToken: string,
  settings: {
    enabled: boolean;
    businessName: string;
    welcomeText: string;
    accent: string;
    position: "left" | "right";
    launcherLabel: string;
  }
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/widget/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: settings.enabled,
        business_name: settings.businessName,
        welcome_text: settings.welcomeText,
        accent: settings.accent,
        position: settings.position,
        launcher_label: settings.launcherLabel,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Conversation tags (labels)
// ---------------------------------------------------------------------------

export interface ConversationTagSummary {
  tag: string;
  count: number;
}

export async function getConversationTagSummary(
  accessToken: string
): Promise<ConversationTagSummary[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/tags/summary"
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
  const rows = (payload as Record<string, unknown>).tags;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object"
    )
    .map((row) => ({
      tag: typeof row.tag === "string" ? row.tag : "",
      count: typeof row.count === "number" ? row.count : 0,
    }))
    .filter((row) => row.tag !== "");
}

export type ConversationTagWriteResult =
  | { kind: "ok"; duplicate: boolean }
  | { kind: "invalid" }
  | { kind: "limit_reached" };

export async function addConversationTag(
  accessToken: string,
  conversationId: number,
  tag: string
): Promise<ConversationTagWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/tags",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) return { kind: "limit_reached" };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  const duplicate =
    payload !== null &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).duplicate === true;
  return { kind: "ok", duplicate };
}

export async function removeConversationTag(
  accessToken: string,
  conversationId: number,
  tag: string
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        conversationId +
        "/tags?tag=" +
        encodeURIComponent(tag),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

// ---------------------------------------------------------------------------
// Saved replies (canned response templates)
// ---------------------------------------------------------------------------

export interface SavedReply {
  id: number;
  shortcut: string;
  body: string;
  createdAt: string | null;
}

function normalizeSavedReply(value: unknown): SavedReply | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    shortcut: typeof p.shortcut === "string" ? p.shortcut : "",
    body: typeof p.body === "string" ? p.body : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listSavedReplies(
  accessToken: string
): Promise<SavedReply[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/saved-replies");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).replies;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeSavedReply(row))
    .filter((row): row is SavedReply => row !== null);
}

export type SavedReplyWriteResult =
  | { kind: "ok"; reply: SavedReply }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "limit_reached" };

export async function createSavedReply(
  accessToken: string,
  shortcut: string,
  body: string
): Promise<SavedReplyWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/saved-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut, body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).error !== null &&
      typeof (payload as Record<string, unknown>).error === "object" &&
      ((payload as Record<string, unknown>).error as Record<string, unknown>)
        .code === "limit_reached"
        ? "limit_reached"
        : "duplicate";
    return { kind: code };
  }
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const reply = normalizeSavedReply(
    (payload as Record<string, unknown>).reply
  );
  if (reply === null) return null;
  return { kind: "ok", reply };
}

export async function deleteSavedReply(
  accessToken: string,
  replyId: number
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/saved-replies/" + replyId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

// ---------------------------------------------------------------------------
// Conversation export (CSV download source)
// ---------------------------------------------------------------------------

export interface ConversationExportFilters {
  searchQuery?: string;
  statusFilter?: string;
  intentFilter?: string;
  channelFilter?: string;
  tagFilter?: string;
}

export async function exportConversations(
  accessToken: string,
  filters: ConversationExportFilters = {}
): Promise<ConversationSummary[] | null> {
  const parts: string[] = [];
  if (filters.searchQuery) {
    parts.push("q=" + encodeURIComponent(filters.searchQuery));
  }
  if (filters.statusFilter && filters.statusFilter !== "all") {
    parts.push("status=" + encodeURIComponent(filters.statusFilter));
  }
  if (filters.intentFilter && filters.intentFilter !== "all") {
    parts.push("intent=" + encodeURIComponent(filters.intentFilter));
  }
  if (filters.channelFilter && filters.channelFilter !== "all") {
    parts.push("channel=" + encodeURIComponent(filters.channelFilter));
  }
  if (filters.tagFilter && filters.tagFilter !== "all") {
    parts.push("tag=" + encodeURIComponent(filters.tagFilter));
  }
  const query = parts.length ? "?" + parts.join("&") : "";

  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/export" + query
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
  const rows = (payload as Record<string, unknown>).conversations;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeConversation(row))
    .filter((row): row is ConversationSummary => row !== null);
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
