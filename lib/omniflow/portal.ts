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

export function controlPlaneBaseUrl(): URL {
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
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const url = new URL(path.replace(/^\//, ""), controlPlaneBaseUrl());
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);
  // string bodies are JSON here; without the header Flask reads no body
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
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

export type ConversationChipCounts = {
  needsReply: number;
  overdue: number;
  unassigned: number;
  unread: number;
};

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
  needsReply: boolean;
  vip: boolean;
  paidOrders: number;
  lastIntent: string | null;
  leadScore: number;
  leadTemp: string;
  assignedTo: string | null;
  assigneeName: string | null;
  starred: boolean;
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
    needsReply: p.needs_reply === true,
    vip: p.vip === true,
    paidOrders: typeof p.paid_orders === "number" ? p.paid_orders : 0,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,
    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
    starred: p.starred === true,
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
  tagFilter?: string,
  needsReplyFilter?: string,
  sortOrder?: string,
  assignedFilter?: string,
  includeCounts?: boolean,
  limit?: number,
  daysFilter?: string,
  unreadFilter?: string,
  starredFilter?: string,
  page?: number
): Promise<
  { conversations: ConversationSummary[]; counts: ConversationChipCounts | null } | null
> {
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
  const replyPart =
    needsReplyFilter === "1" || needsReplyFilter === "overdue"
      ? "needs_reply=" + needsReplyFilter
      : "";
  const sortPart = sortOrder === "oldest" ? "sort=oldest" : "";
  const assignedPart =
    assignedFilter === "unassigned" || assignedFilter === "me"
      ? "assigned=" + assignedFilter
      : "";
  const countsPart = includeCounts ? "include=counts,vip" : "include=vip";
  const limitPart =
    limit && limit >= 1 && limit <= 50 ? "limit=" + Math.floor(limit) : "";
  const daysPart = daysFilter ? "days=" + encodeURIComponent(daysFilter) : "";
  const unreadPart = unreadFilter === "1" ? "unread=1" : "";
  const starredPart = starredFilter === "1" ? "starred=1" : "";
  const pagePart = page && page >= 2 && page <= 100 ? "page=" + Math.floor(page) : "";
  const parts = [
    searchPart,
    statusPart,
    intentPart,
    channelPart,
    tagPart,
    replyPart,
    sortPart,
    assignedPart,
    countsPart,
    limitPart,
    daysPart,
    unreadPart,
    starredPart,
    pagePart,
  ].filter(Boolean);
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
  const rawCounts = (payload as Record<string, unknown>).counts;
  let counts: ConversationChipCounts | null = null;
  if (rawCounts && typeof rawCounts === "object") {
    const record = rawCounts as Record<string, unknown>;
    counts = {
      needsReply: Number(record.needs_reply) || 0,
      overdue: Number(record.overdue) || 0,
      unassigned: Number(record.unassigned) || 0,
      unread: Number(record.unread) || 0,
    };
  }
  return { conversations, counts };
}

export async function bulkConversations(
  accessToken: string,
  action: string,
  ids: number[],
  assigneeEmail?: string
): Promise<{ updated: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/conversations/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        action === "assign"
          ? { action, ids, assignee_email: assigneeEmail || "" }
          : { action, ids }
      ),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const updated = (payload as Record<string, unknown>).updated;
  return { updated: typeof updated === "number" ? updated : 0 };
}

export async function toggleConversationStar(
  accessToken: string,
  conversationId: number
): Promise<{ starred: boolean } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/star",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { starred: false };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return { starred: (payload as Record<string, unknown>).starred === true };
}

export type ConversationDetailResult =
  | {
      kind: "ok";
      conversation: ConversationSummary;
      messages: ConversationMessage[];
      hasMore: boolean;
    }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeConversationMessages(raw: unknown): ConversationMessage[] {
  const rawMessages = Array.isArray(raw) ? raw : [];
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
  return messages;
}

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
  return {
    kind: "ok",
    conversation,
    messages: normalizeConversationMessages(p.messages),
    hasMore: p.has_more === true,
  };
}

export type ConversationMessagesResult =
  | { kind: "ok"; messages: ConversationMessage[]; hasMore: boolean }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function getConversationMessages(
  accessToken: string,
  conversationId: number,
  beforeId: number
): Promise<ConversationMessagesResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/messages?before_id=" +
        encodeURIComponent(String(beforeId))
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
    messages: normalizeConversationMessages(p.messages),
    hasMore: p.has_more === true,
  };
}

export interface BusinessHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}

export interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  days: BusinessHoursDay[];
  away_message: string;
  away_message_ur?: string;
  away_message_roman?: string;
}

export async function getBusinessHours(
  accessToken: string
): Promise<{ business_hours: BusinessHoursConfig } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/business-hours", {});
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    business_hours?: BusinessHoursConfig;
  } | null;
  if (!payload || !payload.business_hours) return null;
  return { business_hours: payload.business_hours };
}

export async function updateBusinessHours(
  accessToken: string,
  config: unknown
): Promise<
  { kind: "ok"; business_hours: BusinessHoursConfig } | { kind: "rejected"; message: string } | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_hours: config }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      kind: "rejected",
      message: payload?.error?.message ?? "Invalid business hours.",
    };
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    business_hours?: BusinessHoursConfig;
  } | null;
  if (!payload || !payload.business_hours) return null;
  return { kind: "ok", business_hours: payload.business_hours };
}

export async function markAllConversationsRead(
  accessToken: string
): Promise<{ updated: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/conversations/read-all", {
      method: "POST",
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const updated = (payload as Record<string, unknown>).updated;
  return { updated: typeof updated === "number" ? updated : 0 };
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

export type KbLang = "auto" | "en" | "ur" | "roman";

export interface KbEntry {
  id: number;
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  usageCount: number;
  lang: KbLang;
  brandId: number | null;
}

export interface KbEntryInput {
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  lang: KbLang;
  brandId?: number | null;
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
    lang:
      raw.lang === "en" || raw.lang === "ur" || raw.lang === "roman"
        ? raw.lang
        : "auto",
    brandId: typeof raw.brand_id === "number" ? raw.brand_id : null,
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
          lang: entry.lang,
          brand_id: entry.brandId ?? null,
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
            lang: entry.lang,
            brand_id: entry.brandId ?? null,
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
  price: number;
  stock: number;
  imageUrl: string;
  source: string;
  syncedAt: string | null;
  brandId: number | null;
  brandName: string | null;
}

export interface CatalogItemInput {
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
  price?: number;
  stock?: number;
  imageUrl?: string;
  brandId?: number | null;
}

export interface CatalogSyncSettings {
  source: string;
  base_url: string;
  api_key_masked: string;
  api_secret_masked: string;
  last_sync_at: string | null;
  last_sync_count: number;
}

export async function getCatalogSyncSettings(
  accessToken: string
): Promise<CatalogSyncSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/catalog/sync/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as CatalogSyncSettings | null;
}

export async function putCatalogSyncSettings(
  accessToken: string,
  input: {
    source: string;
    base_url: string;
    api_key?: string;
    api_secret?: string;
  }
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/catalog/sync/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function syncCatalogNow(
  accessToken: string
): Promise<{
  ok: boolean;
  source: string;
  imported: number;
  updated: number;
  pulled: number;
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/catalog/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    source: string;
    imported: number;
    updated: number;
    pulled: number;
  } | null;
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
  conversationId: number | null;
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
    price: typeof raw.price === "number" ? raw.price : 0,
    stock: typeof raw.stock === "number" ? raw.stock : 0,
    imageUrl: typeof raw.image_url === "string" ? raw.image_url : "",
    source: typeof raw.source === "string" ? raw.source : "manual",
    syncedAt: typeof raw.synced_at === "string" ? raw.synced_at : null,
    brandId: typeof raw.brand_id === "number" ? raw.brand_id : null,
    brandName: typeof raw.brand_name === "string" ? raw.brand_name : null,
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
          brand_id: item.brandId ?? null,
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
            brand_id: item.brandId ?? null,
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
        conversationId:
          typeof raw.conversation_id === "number" ? raw.conversation_id : null,
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
  service: AnalyticsService;
}

export interface AnalyticsService {
  resolutionRate: number | null;
  frtAvgSeconds: number | null;
  frtMedianSeconds: number | null;
  answeredConversations: number;
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
  const svc =
    p.service !== null && typeof p.service === "object"
      ? (p.service as Record<string, unknown>)
      : {};
  const svcNum = (value: unknown): number | null =>
    typeof value === "number" ? value : null;
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
    service: {
      resolutionRate: svcNum(svc.resolution_rate),
      frtAvgSeconds: svcNum(svc.frt_avg_seconds),
      frtMedianSeconds: svcNum(svc.frt_median_seconds),
      answeredConversations: num(svc.answered_conversations),
    },
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
// Team: agent performance (last N days, deterministic)
// ---------------------------------------------------------------------------

export interface TeamPerformanceMember {
  id: number;
  email: string;
  name: string;
  role: TeamRole;
  status: string;
  repliesSent: number;
  conversationsTouched: number;
  notesAdded: number;
  assignedOpen: number;
}

export interface CsatLowBucket {
  score: number;
  count: number;
}

export interface CsatRecentRating {
  score: number;
  at: string;
}

export interface TeamPerformanceBoard {
  openConversations: number;
  unassignedOpen: number;
  repliesSent: number;
  csatAvg: number | null;
  csatAnswered: number;
  csatDist: number[];
  csatLow: CsatLowBucket[];
  csatRecent: CsatRecentRating[];
}

export interface TeamPerformanceData {
  windowDays: number;
  members: TeamPerformanceMember[];
  board: TeamPerformanceBoard;
}

function normalizePerformanceMember(value: unknown): TeamPerformanceMember | null {
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
    repliesSent: typeof p.replies_sent === "number" ? p.replies_sent : 0,
    conversationsTouched:
      typeof p.conversations_touched === "number" ? p.conversations_touched : 0,
    notesAdded: typeof p.notes_added === "number" ? p.notes_added : 0,
    assignedOpen: typeof p.assigned_open === "number" ? p.assigned_open : 0,
  };
}

export async function getTeamPerformance(
  accessToken: string
): Promise<TeamPerformanceData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/team/performance");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawMembers = p.members;
  const members: TeamPerformanceMember[] = [];
  if (Array.isArray(rawMembers)) {
    for (const raw of rawMembers) {
      const row = normalizePerformanceMember(raw);
      if (row) members.push(row);
    }
  }
  const boardRaw =
    p.board !== null && typeof p.board === "object"
      ? (p.board as Record<string, unknown>)
      : {};
  return {
    windowDays: typeof p.window_days === "number" ? p.window_days : 7,
    members,
    board: {
      openConversations:
        typeof boardRaw.open_conversations === "number"
          ? boardRaw.open_conversations
          : 0,
      unassignedOpen:
        typeof boardRaw.unassigned_open === "number" ? boardRaw.unassigned_open : 0,
      repliesSent: typeof boardRaw.replies_sent === "number" ? boardRaw.replies_sent : 0,
      csatAvg: typeof boardRaw.csat_avg === "number" ? boardRaw.csat_avg : null,
      csatAnswered:
        typeof boardRaw.csat_answered === "number" ? boardRaw.csat_answered : 0,
      csatDist:
        Array.isArray(boardRaw.csat_dist) && boardRaw.csat_dist.length === 5
          ? boardRaw.csat_dist.map((value) => (typeof value === "number" ? value : 0))
          : [0, 0, 0, 0, 0],
      csatLow: Array.isArray(boardRaw.csat_low)
        ? boardRaw.csat_low
            .map((bucket) => ({
              score: typeof bucket.score === "number" ? bucket.score : 0,
              count: typeof bucket.count === "number" ? bucket.count : 0,
            }))
            .filter((bucket) => bucket.score > 0 && bucket.count > 0)
        : [],
      csatRecent: Array.isArray(boardRaw.csat_recent)
        ? boardRaw.csat_recent
            .map((entry) => ({
              score: typeof entry.score === "number" ? entry.score : 0,
              at: typeof entry.at === "string" ? entry.at : "",
            }))
            .filter((entry) => entry.score > 0 && entry.at)
        : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Overview: live command center (deterministic, 24h window)
// ---------------------------------------------------------------------------

export interface OverviewHotLead {
  id: number;
  contactId: string;
  contactName: string;
  leadScore: number | null;
  preview: string | null;
  lastMessageAt: string | null;
}

export interface OverviewData {
  newChats: number;
  inboundMessages: number;
  teamReplies: number;
  openNow: number;
  unassignedOpen: number;
  needsReplyOpen: number;
  needsReplyOverdue: number;
  hotLeads: OverviewHotLead[];
}

function normalizeOverviewHotLead(value: unknown): OverviewHotLead | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const contactId = typeof p.contact_id === "string" ? p.contact_id : "";
  if (id === null || !contactId) return null;
  return {
    id,
    contactId,
    contactName: typeof p.contact_name === "string" ? p.contact_name : "",
    leadScore: typeof p.lead_score === "number" ? p.lead_score : null,
    preview: typeof p.preview === "string" ? p.preview : null,
    lastMessageAt:
      typeof p.last_message_at === "string" ? p.last_message_at : null,
  };
}

export async function getOverview(
  accessToken: string
): Promise<OverviewData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/overview");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const stats =
    p.stats !== null && typeof p.stats === "object"
      ? (p.stats as Record<string, unknown>)
      : {};
  const rawLeads = p.hot_leads;
  const hotLeads: OverviewHotLead[] = [];
  if (Array.isArray(rawLeads)) {
    for (const raw of rawLeads) {
      const lead = normalizeOverviewHotLead(raw);
      if (lead) hotLeads.push(lead);
    }
  }
  return {
    newChats: typeof stats.new_chats === "number" ? stats.new_chats : 0,
    inboundMessages:
      typeof stats.inbound_messages === "number" ? stats.inbound_messages : 0,
    teamReplies: typeof stats.team_replies === "number" ? stats.team_replies : 0,
    openNow: typeof stats.open_now === "number" ? stats.open_now : 0,
    unassignedOpen:
      typeof stats.unassigned_open === "number" ? stats.unassigned_open : 0,
    needsReplyOpen:
      typeof stats.needs_reply_open === "number" ? stats.needs_reply_open : 0,
    needsReplyOverdue:
      typeof stats.needs_reply_overdue === "number" ? stats.needs_reply_overdue : 0,
    hotLeads,
  };
}

// ---------------------------------------------------------------------------
// Automations: welcome message (new-conversation greeting)
// ---------------------------------------------------------------------------

export interface WelcomeAutomationSettings {
  enabled: boolean;
  text: string;
}

export type WelcomeSaveResult =
  | { kind: "ok"; enabled: boolean; text: string }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getWelcomeAutomation(
  accessToken: string
): Promise<WelcomeAutomationSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/welcome");
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
    enabled: p.enabled === true,
    text: typeof p.text === "string" ? p.text : "",
  };
}

export async function saveWelcomeAutomation(
  accessToken: string,
  enabled: boolean,
  text: string
): Promise<WelcomeSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/welcome", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, text }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return { kind: "ok", enabled: p.enabled === true, text: typeof p.text === "string" ? p.text : "" };
}

// ---------------------------------------------------------------------------
// Automations: auto-close idle chats (deterministic sweep)
// ---------------------------------------------------------------------------

export interface AutoCloseSettings {
  enabled: boolean;
  hours: number;
}

export type AutoCloseSaveResult =
  | { kind: "ok"; enabled: boolean; hours: number }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getAutoClose(
  accessToken: string
): Promise<AutoCloseSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoclose");
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
    enabled: p.enabled === true,
    hours: typeof p.hours === "number" && p.hours > 0 ? p.hours : 48,
  };
}

export async function saveAutoClose(
  accessToken: string,
  enabled: boolean,
  hours: number
): Promise<AutoCloseSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoclose", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, hours }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    enabled: p.enabled === true,
    hours: typeof p.hours === "number" && p.hours > 0 ? p.hours : 48,
  };
}

// ---------------------------------------------------------------------------
// Automations: auto-assign new chats (least-loaded teammate)
// ---------------------------------------------------------------------------

export interface AutoAssignSettings {
  enabled: boolean;
}

export type AutoAssignSaveResult =
  | { kind: "ok"; enabled: boolean }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getAutoAssign(
  accessToken: string
): Promise<AutoAssignSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoassign");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return { enabled: p.enabled === true };
}

export async function saveAutoAssign(
  accessToken: string,
  enabled: boolean
): Promise<AutoAssignSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoassign", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return { kind: "ok", enabled: p.enabled === true };
}

// ---------------------------------------------------------------------------
// Customers: contact-level notes (CRM)
// ---------------------------------------------------------------------------

export interface CustomerNote {
  id: number;
  body: string;
  authorEmail: string;
  authorName: string;
  createdAt: string | null;
}

function normalizeCustomerNote(value: unknown): CustomerNote | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const body = typeof p.body === "string" ? p.body : "";
  if (id === null || !body) return null;
  return {
    id,
    body,
    authorEmail: typeof p.author_email === "string" ? p.author_email : "",
    authorName: typeof p.author_name === "string" ? p.author_name : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listCustomerNotes(
  accessToken: string,
  contactId: string
): Promise<CustomerNote[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/notes?contact_id=" +
        encodeURIComponent(contactId.slice(0, 120))
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
  if (!Array.isArray(rawNotes)) return [];
  const notes: CustomerNote[] = [];
  for (const raw of rawNotes) {
    const note = normalizeCustomerNote(raw);
    if (note) notes.push(note);
  }
  return notes;
}

export type CustomerNoteAddResult =
  | { kind: "ok"; note: CustomerNote }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function addCustomerNote(
  accessToken: string,
  contactId: string,
  body: string
): Promise<CustomerNoteAddResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId.slice(0, 120), body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const note = normalizeCustomerNote((payload as Record<string, unknown>).note);
  if (!note) return { kind: "unavailable" };
  return { kind: "ok", note };
}

export type CustomerNoteDeleteResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function deleteCustomerNote(
  accessToken: string,
  noteId: number
): Promise<CustomerNoteDeleteResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/notes/" + encodeURIComponent(String(noteId)),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  return response.ok ? { kind: "ok" } : { kind: "unavailable" };
}

export type CustomerMessageResult =
  | { kind: "ok"; commandId: number | null }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function sendCustomerMessage(
  accessToken: string,
  contactId: string,
  body: string
): Promise<CustomerMessageResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId.slice(0, 120), body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  const p =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  return {
    kind: "ok",
    commandId: typeof p.command_id === "number" ? p.command_id : null,
  };
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
  useCount: number;
  lastUsedAt: string | null;
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
    useCount: typeof p.use_count === "number" ? p.use_count : 0,
    lastUsedAt: typeof p.last_used_at === "string" ? p.last_used_at : null,
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
  ids?: number[];
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
  if (filters.ids && filters.ids.length) {
    parts.push("ids=" + filters.ids.slice(0, 100).join(","));
  }
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

// ---------------------------------------------------------------------------
// Customers (contacts aggregated across conversations)
// ---------------------------------------------------------------------------

export interface CustomerSummary {
  contactId: string;
  name: string;
  channels: string[];
  conversationCount: number;
  openCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  leadTemp: string;
  tags: string[];
}

function normalizeCustomer(value: unknown): CustomerSummary | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const contactId =
    typeof p.contact_id === "string" ? p.contact_id : "";
  if (!contactId) return null;
  return {
    contactId,
    name: typeof p.name === "string" ? p.name : "",
    channels: Array.isArray(p.channels)
      ? p.channels.filter((c): c is string => typeof c === "string")
      : [],
    conversationCount:
      typeof p.conversation_count === "number" ? p.conversation_count : 0,
    openCount: typeof p.open_count === "number" ? p.open_count : 0,
    lastMessageAt:
      typeof p.last_message_at === "string" ? p.last_message_at : null,
    lastMessagePreview:
      typeof p.last_message_preview === "string"
        ? p.last_message_preview
        : null,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    tags: Array.isArray(p.tags)
      ? p.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}

export async function listCustomers(
  accessToken: string,
  searchQuery?: string,
  channelFilter?: string
): Promise<CustomerSummary[] | null> {
  const parts: string[] = [];
  if (searchQuery) parts.push("q=" + encodeURIComponent(searchQuery));
  if (channelFilter && channelFilter !== "all") {
    parts.push("channel=" + encodeURIComponent(channelFilter));
  }
  const query = parts.length ? "?" + parts.join("&") : "";

  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers" + query
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
  const rows = (payload as Record<string, unknown>).customers;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeCustomer(row))
    .filter((row): row is CustomerSummary => row !== null);
}

// ---------------------------------------------------------------------------
// Automations (deterministic keyword rules)
// ---------------------------------------------------------------------------

export interface AutomationRule {
  id: number;
  keyword: string;
  actionType: "add_tag" | "assign";
  actionValue: string;
  isActive: boolean;
  timesTriggered: number;
  createdAt: string | null;
}

function normalizeAutomation(value: unknown): AutomationRule | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    keyword: typeof p.keyword === "string" ? p.keyword : "",
    actionType: p.action_type === "assign" ? "assign" : "add_tag",
    actionValue: typeof p.action_value === "string" ? p.action_value : "",
    isActive: p.is_active === true,
    timesTriggered: typeof p.times_triggered === "number" ? p.times_triggered : 0,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listAutomations(
  accessToken: string
): Promise<AutomationRule[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).automations;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeAutomation(row))
    .filter((row): row is AutomationRule => row !== null);
}

export type AutomationWriteResult =
  | { kind: "ok"; automation: AutomationRule }
  | { kind: "invalid" }
  | { kind: "assignee_not_found" }
  | { kind: "duplicate" }
  | { kind: "limit_reached" };

export async function createAutomation(
  accessToken: string,
  keyword: string,
  actionType: "add_tag" | "assign",
  actionValue: string
): Promise<AutomationWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword,
        action_type: actionType,
        action_value: actionValue,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
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
    return { kind: "invalid" };
  }
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const error = payload as {
      error?: { code?: string };
    } | null;
    if (error?.error?.code === "limit_reached") return { kind: "limit_reached" };
    return { kind: "duplicate" };
  }
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const automation = normalizeAutomation(
    (payload as Record<string, unknown>).automation
  );
  if (automation === null) return null;
  return { kind: "ok", automation };
}

export async function setAutomationActive(
  accessToken: string,
  ruleId: number,
  isActive: boolean
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/automations/" + ruleId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

export async function deleteAutomation(
  accessToken: string,
  ruleId: number
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/automations/" + ruleId,
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

export interface ScheduledBroadcast {
  id: number;
  audience: string;
  body: string;
  recipientCount: number;
  sendAt: string;
  createdAt: string;
}

function normalizeScheduledBroadcast(payload: unknown): ScheduledBroadcast | null {
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : 0;
  if (!id) return null;
  return {
    id,
    audience: typeof row.audience === "string" ? row.audience : "all",
    body: typeof row.body === "string" ? row.body : "",
    recipientCount: typeof row.recipient_count === "number" ? row.recipient_count : 0,
    sendAt: typeof row.send_at === "string" ? row.send_at : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
  };
}

export async function listScheduledBroadcasts(
  accessToken: string
): Promise<ScheduledBroadcast[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts/scheduled");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).scheduled;
  if (!Array.isArray(rawList)) return null;
  const scheduled: ScheduledBroadcast[] = [];
  for (const item of rawList) {
    const normalized = normalizeScheduledBroadcast(item);
    if (normalized) scheduled.push(normalized);
  }
  return scheduled;
}

export type ScheduleBroadcastResult =
  | { kind: "ok"; scheduled: ScheduledBroadcast }
  | { kind: "no_recipients" }
  | { kind: "too_many_recipients" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function scheduleBroadcast(
  accessToken: string,
  audience: string,
  body: string,
  sendAtIso: string
): Promise<ScheduleBroadcastResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience, body, send_at: sendAtIso }),
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
    if (code === "too_many_recipients") return { kind: "too_many_recipients" };
    return { kind: "invalid" };
  }
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const scheduled = normalizeScheduledBroadcast(
    (payload as Record<string, unknown>).scheduled
  );
  if (!scheduled) return { kind: "unavailable" };
  return { kind: "ok", scheduled };
}

export async function cancelScheduledBroadcast(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/broadcasts/scheduled/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface CodSettings {
  enabled: boolean;
  template: string;
}

export interface CodRequest {
  id: number;
  conversationId: number | null;
  contactId: string;
  contactName: string | null;
  status: "pending" | "confirmed" | "declined";
  createdAt: string;
  answeredAt: string | null;
}

export async function getCodSettings(
  accessToken: string
): Promise<CodSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cod/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).settings;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    template: typeof row.template === "string" ? row.template : "",
  };
}

export async function saveCodSettings(
  accessToken: string,
  settings: CodSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cod/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: settings.enabled, template: settings.template }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

function normalizeCodRequest(payload: unknown): CodRequest | null {
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : 0;
  if (!id) return null;
  const status =
    row.status === "confirmed" || row.status === "declined" ? row.status : "pending";
  return {
    id,
    conversationId: typeof row.conversation_id === "number" ? row.conversation_id : null,
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    contactName: typeof row.contact_name === "string" ? row.contact_name : null,
    status,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    answeredAt: typeof row.answered_at === "string" ? row.answered_at : null,
  };
}

export async function listCodRequests(
  accessToken: string,
  status: "all" | "pending" | "confirmed" | "declined"
): Promise<{ requests: CodRequest[]; counts: Record<string, number> } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/cod/requests?status=" + encodeURIComponent(status)
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
  const p = payload as Record<string, unknown>;
  const rawList = p.requests;
  if (!Array.isArray(rawList)) return null;
  const requests: CodRequest[] = [];
  for (const item of rawList) {
    const normalized = normalizeCodRequest(item);
    if (normalized) requests.push(normalized);
  }
  const counts =
    p.counts !== null && typeof p.counts === "object"
      ? (p.counts as Record<string, unknown>)
      : {};
  const safeCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") safeCounts[key] = value;
  }
  return { requests, counts: safeCounts };
}

export interface ImportedCustomerRow {
  name?: string;
  phone: string;
}

export interface CustomerImportResult {
  created: number;
  merged: number;
  invalid: { row: number; reason: string }[];
  invalid_count: number;
}

export async function importCustomers(
  accessToken: string,
  customers: ImportedCustomerRow[]
): Promise<CustomerImportResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customers }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    created: typeof p.created === "number" ? p.created : 0,
    merged: typeof p.merged === "number" ? p.merged : 0,
    invalid: Array.isArray(p.invalid)
      ? (p.invalid as { row: number; reason: string }[])
      : [],
    invalid_count: typeof p.invalid_count === "number" ? p.invalid_count : 0,
  };
}

export type SavedReplyMutation =
  | { kind: "ok"; reply?: SavedReply }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function updateSavedReply(
  accessToken: string,
  id: number,
  shortcut: string,
  body: string
): Promise<SavedReplyMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/saved-replies/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortcut, body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) return { kind: "duplicate" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload !== null && typeof payload === "object") {
    const raw = (payload as Record<string, unknown>).reply;
    if (raw !== null && typeof raw === "object") {
      const row = raw as Record<string, unknown>;
      if (typeof row.id === "number") {
        return {
          kind: "ok",
          reply: {
            id: row.id,
            shortcut: typeof row.shortcut === "string" ? row.shortcut : "",
            body: typeof row.body === "string" ? row.body : "",
            createdAt:
              typeof row.created_at === "string" ? row.created_at : null,
            useCount: typeof row.use_count === "number" ? row.use_count : 0,
            lastUsedAt:
              typeof row.last_used_at === "string" ? row.last_used_at : null,
          },
        };
      }
    }
  }
  return { kind: "ok" };
}

export async function markSavedReplyUsed(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/saved-replies/" + String(id) + "/use",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function exportActivityCsv(
  accessToken: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/activity/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export async function exportCustomersCsv(accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export async function exportRevenueCsv(
  accessToken: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/revenue/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export async function exportReturnsCsv(
  accessToken: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/returns/export"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export type EnrollmentExport =
  | { kind: "ok"; csv: string }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function exportEnrollmentsCsv(
  accessToken: string,
  id: number
): Promise<EnrollmentExport> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id) + "/enrollments/export"
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404 || response.status === 501) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const csv = await response.text().catch(() => null);
  if (csv === null) return { kind: "unavailable" };
  return { kind: "ok", csv };
}

export interface SetupStatus {
  whatsapp: boolean;
  hours: boolean;
  away: boolean;
  kb: boolean;
  customers: boolean;
  broadcast: boolean;
  cod: boolean;
}

export async function getSetupStatus(
  accessToken: string
): Promise<SetupStatus | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/setup/status");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).setup;
  if (raw === null || typeof raw !== "object") return null;
  const checks = ((raw as Record<string, unknown>).checks ?? {}) as Record<string, unknown>;
  const flag = (key: string) => checks[key] === true;
  return {
    whatsapp: flag("whatsapp"),
    hours: flag("hours"),
    away: flag("away"),
    kb: flag("kb"),
    customers: flag("customers"),
    broadcast: flag("broadcast"),
    cod: flag("cod"),
  };
}

export interface WebhookRow {
  id: number;
  url: string;
  events: string;
  enabled: boolean;
  createdAt: string | null;
  lastDeliveryAt: string | null;
  lastStatusCode: number | null;
  deadCount: number;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  statusCode: number | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  deliveredAt: string | null;
  dead: boolean;
}

export async function listWebhooks(
  accessToken: string
): Promise<WebhookRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/webhooks");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).webhooks;
  if (!Array.isArray(rawList)) return null;
  const webhooks: WebhookRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    webhooks.push({
      id: row.id,
      url: typeof row.url === "string" ? row.url : "",
      events: typeof row.events === "string" ? row.events : "all",
      enabled: row.enabled === true,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      lastDeliveryAt: typeof row.last_delivery_at === "string" ? row.last_delivery_at : null,
      lastStatusCode: typeof row.last_status_code === "number" ? row.last_status_code : null,
      deadCount: typeof row.dead_count === "number" ? row.dead_count : 0,
    });
  }
  return webhooks;
}

export type WebhookMutation =
  | { kind: "ok"; webhook?: WebhookRow; secret?: string }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createWebhook(
  accessToken: string,
  url: string,
  events: string
): Promise<WebhookMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, events }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const raw = (payload as Record<string, unknown>).webhook;
  // the Control Plane returns the one-time signing secret inside `webhook`
  const secret =
    (payload as Record<string, unknown>).secret ??
    (raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>).secret
      : undefined);
  const webhook =
    raw !== null && typeof raw === "object"
      ? ({
          id: (raw as Record<string, unknown>).id as number,
          url: (raw as Record<string, unknown>).url as string,
          events: (raw as Record<string, unknown>).events as string,
          enabled: true,
          createdAt: null,
          lastDeliveryAt: null,
          lastStatusCode: null,
          deadCount: 0,
        } as WebhookRow)
      : undefined;
  return {
    kind: "ok",
    webhook,
    secret: typeof secret === "string" ? secret : undefined,
  };
}

export async function updateWebhook(
  accessToken: string,
  id: number,
  changes: { url?: string; events?: string; enabled?: boolean }
): Promise<WebhookMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function deleteWebhook(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function listWebhookDeliveries(
  accessToken: string,
  id: number
): Promise<WebhookDelivery[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) + "/deliveries"
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
  const rawList = (payload as Record<string, unknown>).deliveries;
  if (!Array.isArray(rawList)) return null;
  const deliveries: WebhookDelivery[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    deliveries.push({
      id: row.id,
      event: typeof row.event === "string" ? row.event : "",
      statusCode: typeof row.status_code === "number" ? row.status_code : null,
      error: typeof row.error === "string" ? row.error : null,
      attempts: typeof row.attempts === "number" ? row.attempts : 0,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      deliveredAt: typeof row.delivered_at === "string" ? row.delivered_at : null,
      dead: row.dead === true,
    });
  }
  return deliveries;
}

export interface SequenceStep {
  step_no: number;
  delay_hours: number;
  body: string;
  onlyIfIdleHours: number | null;
}

export interface SequenceRow {
  id: number;
  name: string;
  enabled: boolean;
  steps: SequenceStep[];
  activeEnrollments: number;
  completedEnrollments: number;
  triggerKeyword: string | null;
  pauseOnReply: boolean;
  /** §236 smart stops: stop when the customer buys / a person takes over. */
  stopOnPurchase: boolean;
  stopOnHuman: boolean;
}

export async function listSequences(
  accessToken: string
): Promise<SequenceRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).sequences;
  if (!Array.isArray(rawList)) return null;
  const sequences: SequenceRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    const steps = Array.isArray(row.steps)
      ? (row.steps as Record<string, unknown>[]).map((step) => ({
          step_no: typeof step.step_no === "number" ? step.step_no : 0,
          delay_hours: typeof step.delay_hours === "number" ? step.delay_hours : 0,
          body: typeof step.body === "string" ? step.body : "",
          onlyIfIdleHours:
            typeof step.only_if_idle_hours === "number"
              ? step.only_if_idle_hours
              : null,
        }))
      : [];
    sequences.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      enabled: row.enabled === true,
      steps,
      activeEnrollments: typeof row.active_enrollments === "number" ? row.active_enrollments : 0,
      completedEnrollments:
        typeof row.completed_enrollments === "number" ? row.completed_enrollments : 0,
      pauseOnReply: row.pause_on_reply !== false,
      triggerKeyword: typeof row.trigger_keyword === "string" ? row.trigger_keyword : null,
      stopOnPurchase: row.stop_on_purchase !== false,
      stopOnHuman: row.stop_on_human !== false,
    });
  }
  return sequences;
}

export type SequenceMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createSequence(
  accessToken: string,
  name: string,
  steps: {
    delay_hours: number;
    body: string;
    only_if_idle_hours?: number | null;
  }[],
  triggerKeyword?: string | null
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        triggerKeyword ? { name, steps, trigger_keyword: triggerKeyword } : { name, steps }
      ),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function updateSequence(
  accessToken: string,
  id: number,
  changes: {
    name?: string;
    enabled?: boolean;
    triggerKeyword?: string | null;
    pauseOnReply?: boolean;
    stopOnPurchase?: boolean;
    stopOnHuman?: boolean;
  }
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify((() => {
          const wire: Record<string, unknown> = {};
          if ("name" in changes) wire.name = changes.name;
          if ("enabled" in changes) wire.enabled = changes.enabled;
          if ("triggerKeyword" in changes) {
            wire.trigger_keyword = changes.triggerKeyword ?? null;
          }
          if ("pauseOnReply" in changes) {
            wire.pause_on_reply = changes.pauseOnReply === true;
          }
          if ("stopOnPurchase" in changes) {
            wire.stop_on_purchase = changes.stopOnPurchase === true;
          }
          if ("stopOnHuman" in changes) {
            wire.stop_on_human = changes.stopOnHuman === true;
          }
          return wire;
        })()),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function updateSequenceSteps(
  accessToken: string,
  id: number,
  steps: {
    delay_hours: number;
    body: string;
    only_if_idle_hours?: number | null;
  }[]
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id) + "/steps",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SequenceSettings {
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  utcOffset: number;
  /** §236: hours between follow-ups of different series in one chat
   * (sent only when set; null = back to the platform default). */
  gapHours?: number | null;
  gapHoursDefault?: number;
}

export async function getSequenceSettings(
  accessToken: string
): Promise<SequenceSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    quietEnabled: row.quiet_enabled === true,
    quietStart: typeof row.quiet_start === "number" ? row.quiet_start : 22,
    quietEnd: typeof row.quiet_end === "number" ? row.quiet_end : 8,
    utcOffset: typeof row.utc_offset === "number" ? row.utc_offset : 5,
    gapHours: typeof row.gap_hours === "number" ? row.gap_hours : null,
    gapHoursDefault: typeof row.gap_hours_default === "number" ? row.gap_hours_default : 4,
  };
}

export async function saveSequenceSettings(
  accessToken: string,
  settings: SequenceSettings
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quiet_enabled: settings.quietEnabled,
        quiet_start: settings.quietStart,
        quiet_end: settings.quietEnd,
        utc_offset: settings.utcOffset,
        ...(settings.gapHours !== undefined ? { gap_hours: settings.gapHours } : {}),
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SequenceStepStat {
  stepNo: number;
  sent: number;
  skipped: number;
  /** §236: enrollments that stopped by themselves before this step. */
  stopped: number;
}

export async function getSequenceStats(
  accessToken: string,
  id: number
): Promise<SequenceStepStat[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id) + "/stats"
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
  const list = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(list)) return null;
  return list
    .map((item) => {
      const row =
        item !== null && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      return {
        stepNo: typeof row.step_no === "number" ? row.step_no : 0,
        sent: typeof row.sent === "number" ? row.sent : 0,
        skipped: typeof row.skipped === "number" ? row.skipped : 0,
        stopped: typeof row.stopped === "number" ? row.stopped : 0,
      };
    })
    .filter((row) => row.stepNo > 0);
}

export interface SegmentFilters {
  lead_temp?: "hot" | "warm" | "cold";
  status?: "open" | "closed";
  stage?: PipelineStage;
  idle_days?: number;
  tag?: string;
}

export interface SegmentRow {
  id: number;
  name: string;
  filters: SegmentFilters;
  memberCount: number;
  createdAt: string | null;
}

function normalizeSegmentFilters(raw: unknown): SegmentFilters {
  const out: SegmentFilters = {};
  if (raw === null || typeof raw !== "object") return out;
  const input = raw as Record<string, unknown>;
  if (
    input.lead_temp === "hot" ||
    input.lead_temp === "warm" ||
    input.lead_temp === "cold"
  ) {
    out.lead_temp = input.lead_temp;
  }
  if (input.status === "open" || input.status === "closed") {
    out.status = input.status;
  }
  if (
    input.stage === "new" ||
    input.stage === "interested" ||
    input.stage === "negotiating" ||
    input.stage === "won" ||
    input.stage === "lost"
  ) {
    out.stage = input.stage;
  }
  if (typeof input.idle_days === "number" && input.idle_days >= 1) {
    out.idle_days = Math.round(input.idle_days);
  }
  if (typeof input.tag === "string" && input.tag.trim()) {
    out.tag = input.tag.trim();
  }
  return out;
}

export async function listSegments(
  accessToken: string
): Promise<SegmentRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/segments");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).segments;
  if (!Array.isArray(rawList)) return null;
  const segments: SegmentRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    segments.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      filters: normalizeSegmentFilters(row.filters),
      memberCount: typeof row.member_count === "number" ? row.member_count : 0,
      createdAt:
        typeof row.created_at === "string" ? row.created_at : null,
    });
  }
  return segments;
}

export type SegmentMutation =
  | { kind: "ok"; segment?: SegmentRow }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createSegment(
  accessToken: string,
  name: string,
  filters: SegmentFilters
): Promise<SegmentMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filters }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const segment =
    payload !== null && typeof payload === "object"
      ? (payload as { segment?: unknown }).segment
      : null;
  if (segment !== null && typeof segment === "object") {
    const row = segment as Record<string, unknown>;
    if (typeof row.id === "number") {
      return {
        kind: "ok",
        segment: {
          id: row.id,
          name: typeof row.name === "string" ? row.name : "",
          filters: normalizeSegmentFilters(row.filters),
          memberCount:
            typeof row.member_count === "number" ? row.member_count : 0,
          createdAt:
            typeof row.created_at === "string" ? row.created_at : null,
        },
      };
    }
  }
  return { kind: "ok" };
}

export async function deleteSegment(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/segments/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SegmentMember {
  contactId: string;
  name: string;
  chats: number;
  lastAt: string | null;
}

export async function listSegmentMembers(
  accessToken: string,
  id: number
): Promise<SegmentMember[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/segments/" + String(id) + "/members?limit=50"
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
  const rawList = (payload as Record<string, unknown>).members;
  if (!Array.isArray(rawList)) return null;
  const members: SegmentMember[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    members.push({
      contactId: row.contact_id,
      name: typeof row.name === "string" ? row.name : "",
      chats: typeof row.chats === "number" ? row.chats : 0,
      lastAt: typeof row.last_at === "string" ? row.last_at : null,
    });
  }
  return members;
}

export async function broadcastToSegment(
  accessToken: string,
  id: number,
  body: string
): Promise<{ kind: "ok"; sent: number } | { kind: "invalid" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/segments/" + String(id) + "/broadcast",
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
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const sent =
    payload !== null && typeof payload === "object"
      ? (payload as { sent?: unknown }).sent
      : null;
  return { kind: "ok", sent: typeof sent === "number" ? sent : 0 };
}

export interface CustomerConversationRef {
  id: number;
  status: string;
  channel: string;
  lastMessageAt: string | null;
}

export interface CustomerProfileAction {
  id: number;
  kind: string;
  status: string;
  note: string;
  createdAt: string | null;
}

export interface CustomerProfile {
  contactId: string;
  name: string;
  leadTemp: string;
  language: string | null;
  linkedChannels: string[];
  actions: CustomerProfileAction[];
  chats: number;
  openChats: number;
  firstSeen: string | null;
  lastSeen: string | null;
  tags: string[];
  conversations: CustomerConversationRef[];
  codRequests: {
    id: number;
    status: string;
    createdAt: string | null;
    answeredAt: string | null;
  }[];
  sequences: {
    name: string;
    status: string;
    currentStep: number;
    enrolledAt: string | null;
  }[];
  notes: {
    body: string;
    authorEmail: string;
    createdAt: string | null;
  }[];
}

export async function getCustomerProfile(
  accessToken: string,
  contact: string
): Promise<CustomerProfile | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/profile?contact=" + encodeURIComponent(contact)
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
  const row = payload as Record<string, unknown>;
  const conversations = Array.isArray(row.conversations)
    ? (row.conversations as Record<string, unknown>[]).map((item) => ({
        id: typeof item.id === "number" ? item.id : 0,
        status: typeof item.status === "string" ? item.status : "open",
        channel: typeof item.channel === "string" ? item.channel : "whatsapp",
        lastMessageAt:
          typeof item.last_message_at === "string"
            ? item.last_message_at
            : null,
      }))
    : [];
  const codRequests = Array.isArray(row.cod_requests)
    ? (row.cod_requests as Record<string, unknown>[]).map((item) => ({
        id: typeof item.id === "number" ? item.id : 0,
        status: typeof item.status === "string" ? item.status : "pending",
        createdAt: typeof item.created_at === "string" ? item.created_at : null,
        answeredAt:
          typeof item.answered_at === "string" ? item.answered_at : null,
      }))
    : [];
  const sequences = Array.isArray(row.sequences)
    ? (row.sequences as Record<string, unknown>[]).map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        status: typeof item.status === "string" ? item.status : "active",
        currentStep: typeof item.current_step === "number" ? item.current_step : 0,
        enrolledAt:
          typeof item.enrolled_at === "string" ? item.enrolled_at : null,
      }))
    : [];
  const notes = Array.isArray(row.notes)
    ? (row.notes as Record<string, unknown>[]).map((item) => ({
        body: typeof item.body === "string" ? item.body : "",
        authorEmail: typeof item.author_email === "string" ? item.author_email : "",
        createdAt: typeof item.created_at === "string" ? item.created_at : null,
      }))
    : [];
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    name: typeof row.name === "string" ? row.name : "",
    leadTemp: typeof row.lead_temp === "string" ? row.lead_temp : "cold",
    chats: typeof row.chats === "number" ? row.chats : 0,
    openChats: typeof row.open_chats === "number" ? row.open_chats : 0,
    firstSeen: typeof row.first_seen === "string" ? row.first_seen : null,
    lastSeen: typeof row.last_seen === "string" ? row.last_seen : null,
    tags: Array.isArray(row.tags)
      ? (row.tags as unknown[]).filter(
          (tag): tag is string => typeof tag === "string"
        )
      : [],
    conversations,
    codRequests,
    sequences,
    notes,
    language: typeof row.language === "string" ? row.language : null,
    linkedChannels: Array.isArray(row.linked_channels)
      ? (row.linked_channels as unknown[]).filter(
          (item): item is string => typeof item === "string"
        )
      : [],
    actions: Array.isArray(row.actions)
      ? (row.actions as Record<string, unknown>[]).map((item) => ({
          id: typeof item.id === "number" ? item.id : 0,
          kind: typeof item.kind === "string" ? item.kind : "",
          status: typeof item.status === "string" ? item.status : "pending",
          note: typeof item.note === "string" ? item.note : "",
          createdAt: typeof item.created_at === "string" ? item.created_at : null,
        }))
      : [],
  };
}

export type PipelineStage =
  | "new"
  | "interested"
  | "negotiating"
  | "won"
  | "lost";

export const PIPELINE_STAGES: PipelineStage[] = [
  "new",
  "interested",
  "negotiating",
  "won",
  "lost",
];

export interface PipelineContact {
  contactId: string;
  name: string;
  leadTemp: string;
  chats: number;
  lastAt: string | null;
}

export interface PipelineColumn {
  stage: PipelineStage;
  count: number;
  contacts: PipelineContact[];
}

export async function getPipelineBoard(
  accessToken: string
): Promise<PipelineColumn[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/pipeline");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawStages = (payload as Record<string, unknown>).stages;
  if (!Array.isArray(rawStages)) return null;
  const columns: PipelineColumn[] = [];
  for (const item of rawStages) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.stage !== "string") continue;
    const rawContacts = Array.isArray(row.contacts) ? row.contacts : [];
    const contacts: PipelineContact[] = [];
    for (const entry of rawContacts) {
      if (entry === null || typeof entry !== "object") continue;
      const contact = entry as Record<string, unknown>;
      if (typeof contact.contact_id !== "string") continue;
      contacts.push({
        contactId: contact.contact_id,
        name: typeof contact.name === "string" ? contact.name : "",
        leadTemp: typeof contact.lead_temp === "string" ? contact.lead_temp : "cold",
        chats: typeof contact.chats === "number" ? contact.chats : 0,
        lastAt: typeof contact.last_at === "string" ? contact.last_at : null,
      });
    }
    columns.push({
      stage: row.stage as PipelineStage,
      count: typeof row.count === "number" ? row.count : contacts.length,
      contacts,
    });
  }
  return columns;
}

export type StageMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function setContactStage(
  accessToken: string,
  contact: string,
  stage: PipelineStage
): Promise<StageMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/pipeline/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, stage }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface WeeklySummary {
  chats: number;
  messagesIn: number;
  messagesOut: number;
  codConfirmed: number;
  codDeclined: number;
  broadcasts: number;
  csatAsked: number;
  csatAvg: number | null;
  days: { day: string; chats: number; inbound: number }[];
}

export async function getWeeklySummary(
  accessToken: string
): Promise<WeeklySummary | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/insights/weekly");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const num = (value: unknown): number =>
    typeof value === "number" ? value : 0;
  const rawDays = Array.isArray(row.days) ? row.days : [];
  const days = rawDays
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object"
    )
    .map((item) => ({
      day: typeof item.day === "string" ? item.day : "",
      chats: num(item.chats),
      inbound: num(item.inbound),
    }));
  const avg = row.csat_avg;
  return {
    chats: num(row.chats),
    messagesIn: num(row.messages_in),
    messagesOut: num(row.messages_out),
    codConfirmed: num(row.cod_confirmed),
    codDeclined: num(row.cod_declined),
    broadcasts: num(row.broadcasts),
    csatAsked: num(row.csat_asked),
    csatAvg: typeof avg === "number" ? avg : null,
    days,
  };
}

export interface CalendarItem {
  id: number;
  day: string;
  audience: string;
  body: string;
  recipients: number;
  scheduled: boolean;
}

export interface BroadcastCalendar {
  month: string;
  days: { date: string; sent: number; scheduled: number }[];
  items: CalendarItem[];
}

export async function getBroadcastCalendar(
  accessToken: string,
  month: string
): Promise<BroadcastCalendar | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/calendar?month=" + encodeURIComponent(month)
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
  const row = payload as Record<string, unknown>;
  const rawDays = Array.isArray(row.days) ? row.days : [];
  const rawItems = Array.isArray(row.items) ? row.items : [];
  return {
    month: typeof row.month === "string" ? row.month : month,
    days: rawDays
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((item) => ({
        date: typeof item.date === "string" ? item.date : "",
        sent: typeof item.sent === "number" ? item.sent : 0,
        scheduled: typeof item.scheduled === "number" ? item.scheduled : 0,
      })),
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((item) => ({
        id: typeof item.id === "number" ? item.id : 0,
        day: typeof item.day === "string" ? item.day : "",
        audience: typeof item.audience === "string" ? item.audience : "all",
        body: typeof item.body === "string" ? item.body : "",
        recipients: typeof item.recipients === "number" ? item.recipients : 0,
        scheduled: item.scheduled === true,
      })),
  };
}

export type MergeMutation =
  | { kind: "ok"; moved: number }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function mergeCustomers(
  accessToken: string,
  keep: string,
  merge: string
): Promise<MergeMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep, merge }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const moved =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).moved
      : null;
  return { kind: "ok", moved: typeof moved === "number" ? moved : 0 };
}

export type ReplyLanguage = "auto" | "en" | "ur" | "roman";

export async function getWorkspaceLanguage(
  accessToken: string
): Promise<ReplyLanguage | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/workspace/language");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const lang =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).reply_language
      : null;
  return lang === "en" || lang === "ur" || lang === "roman" || lang === "auto"
    ? lang
    : "auto";
}

export type LanguageMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function saveWorkspaceLanguage(
  accessToken: string,
  language: ReplyLanguage
): Promise<LanguageMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/workspace/language", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function getContactLanguage(
  accessToken: string,
  contact: string
): Promise<{ lang: string | null; updatedAt: string | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/language?contact=" + encodeURIComponent(contact)
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
  const row = payload as Record<string, unknown>;
  return {
    lang: typeof row.lang === "string" ? row.lang : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export async function detectLanguage(
  accessToken: string,
  text: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/language/detect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const lang =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).lang
      : null;
  return typeof lang === "string" ? lang : null;
}

export async function linkContacts(
  accessToken: string,
  contactA: string,
  contactB: string
): Promise<LanguageMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/contacts/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_a: contactA, contact_b: contactB }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export type ActionMutation =
  | { kind: "ok"; id: number }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createConversationAction(
  accessToken: string,
  conversationId: number,
  kind: string,
  note: string
): Promise<ActionMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + String(conversationId) + "/actions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, note }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const id =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).id
      : null;
  return { kind: "ok", id: typeof id === "number" ? id : 0 };
}

export type ResolveMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function resolveContactAction(
  accessToken: string,
  id: number,
  status: "done" | "declined"
): Promise<ResolveMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/actions/" + String(id),
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
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface ContactAction {
  id: number;
  conversationId: number | null;
  contactId: string;
  kind: string;
  note: string;
  status: string;
  requestedBy: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

export async function listContactActions(
  accessToken: string,
  contact: string,
  status: string
): Promise<ContactAction[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/actions?contact=" +
        encodeURIComponent(contact) +
        "&status=" +
        encodeURIComponent(status)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).actions
    : null;
  if (!Array.isArray(raw)) return [];
  const actions: ContactAction[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    actions.push({
      id: row.id,
      conversationId:
        typeof row.conversation_id === "number" ? row.conversation_id : null,
      contactId: typeof row.contact_id === "string" ? row.contact_id : "",
      kind: typeof row.kind === "string" ? row.kind : "",
      note: typeof row.note === "string" ? row.note : "",
      status: typeof row.status === "string" ? row.status : "pending",
      requestedBy: typeof row.requested_by === "string" ? row.requested_by : null,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : null,
    });
  }
  return actions;
}

export interface IntentResult {
  intent: string;
  entities: { phones: string[]; orderIds: string[]; emails: string[] };
}

export async function classifyIntent(
  accessToken: string,
  text: string
): Promise<IntentResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/intent?text=" + encodeURIComponent(text)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const raw = row.entities;
  const entities =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    intent: typeof row.intent === "string" ? row.intent : "other",
    entities: {
      phones: list(entities.phones),
      orderIds: list(entities.order_ids),
      emails: list(entities.emails),
    },
  };
}

export interface FraudScore {
  score: number;
  level: string;
  reasons: string[];
  declined: number;
  refunds: number;
  chats: number;
}

export async function getFraudScore(
  accessToken: string,
  contact: string
): Promise<FraudScore | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/fraud/score?contact=" + encodeURIComponent(contact)
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
  const row = payload as Record<string, unknown>;
  const reasons = Array.isArray(row.reasons)
    ? row.reasons.filter((item): item is string => typeof item === "string")
    : [];
  return {
    score: typeof row.score === "number" ? row.score : 0,
    level: typeof row.level === "string" ? row.level : "clear",
    reasons,
    declined: typeof row.declined === "number" ? row.declined : 0,
    refunds: typeof row.refunds === "number" ? row.refunds : 0,
    chats: typeof row.chats === "number" ? row.chats : 0,
  };
}

export interface FraudFlag {
  contactId: string;
  score: number;
  level: string;
  reasons: string;
  updatedAt: string | null;
}

export async function listFraudFlags(
  accessToken: string
): Promise<FraudFlag[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/fraud/flags");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).flags
    : null;
  if (!Array.isArray(raw)) return [];
  const flags: FraudFlag[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    flags.push({
      contactId: row.contact_id,
      score: typeof row.score === "number" ? row.score : 0,
      level: typeof row.level === "string" ? row.level : "clear",
      reasons: typeof row.reasons === "string" ? row.reasons : "",
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    });
  }
  return flags;
}

export interface OptOutRow {
  contactId: string;
  reason: string;
  createdAt: string | null;
}

export async function listOptOuts(
  accessToken: string,
  query: string
): Promise<OptOutRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/compliance/optouts?q=" + encodeURIComponent(query)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).optouts
    : null;
  if (!Array.isArray(raw)) return [];
  const rows: OptOutRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    rows.push({
      contactId: row.contact_id,
      reason: typeof row.reason === "string" ? row.reason : "customer",
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    });
  }
  return rows;
}

export interface OptOutMutation {
  ok: boolean;
  contactId: string;
  reason: string;
}

export async function addOptOut(
  accessToken: string,
  contact: string,
  reason: string
): Promise<OptOutMutation | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/compliance/optouts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact, reason }),
      }
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
  const row = payload as Record<string, unknown>;
  return {
    ok: row.ok === true,
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    reason: typeof row.reason === "string" ? row.reason : reason,
  };
}

export type OptOutRemoval = { ok: true } | "not_found" | null;

export async function removeOptOut(
  accessToken: string,
  contact: string
): Promise<OptOutRemoval> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/compliance/optouts?contact=" + encodeURIComponent(contact),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface KbSuggestion {
  id: number;
  question: string;
  snippet: string;
  matched: string[];
}

export interface AssistSentiment {
  label: string;
  score: number;
  engine: "llm" | "lexicon";
  positive: string[];
  negative: string[];
}

export interface AssistResult {
  intent: string;
  sentiment: AssistSentiment | null;
  language: string | null;
  linked: string[];
  suggestions: KbSuggestion[];
  basedOn: string;
}

export async function getConversationAssist(
  accessToken: string,
  conversationId: number
): Promise<AssistResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/assist"
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
  const row = payload as Record<string, unknown>;
  const rawSuggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
  const suggestions: KbSuggestion[] = [];
  for (const item of rawSuggestions) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    suggestions.push({
      id: typeof entry.id === "number" ? entry.id : 0,
      question: typeof entry.question === "string" ? entry.question : "",
      snippet: typeof entry.snippet === "string" ? entry.snippet : "",
      matched: Array.isArray(entry.matched)
        ? entry.matched.filter((m): m is string => typeof m === "string")
        : [],
    });
  }
  let sentiment: AssistSentiment | null = null;
  if (row.sentiment !== null && typeof row.sentiment === "object") {
    const entry = row.sentiment as Record<string, unknown>;
    sentiment = {
      label: typeof entry.label === "string" ? entry.label : "neutral",
      score: typeof entry.score === "number" ? entry.score : 0,
      engine: entry.engine === "llm" ? "llm" as const : "lexicon" as const,
      positive: Array.isArray(entry.positive)
        ? entry.positive.filter((w): w is string => typeof w === "string")
        : [],
      negative: Array.isArray(entry.negative)
        ? entry.negative.filter((w): w is string => typeof w === "string")
        : [],
    };
  }
  return {
    intent: typeof row.intent === "string" ? row.intent : "other",
    sentiment,
    language: typeof row.language === "string" ? row.language : null,
    linked: Array.isArray(row.linked)
      ? row.linked.filter((m): m is string => typeof m === "string")
      : [],
    suggestions,
    basedOn: typeof row.based_on === "string" ? row.based_on : "",
  };
}

async function controlPlanePublicRequest(
  path: string,
  init?: RequestInit
): Promise<Response | null> {
  try {
    const url = new URL(path.replace(/^\//, ""), controlPlaneBaseUrl());
    return await fetch(url, {
      ...(init ?? {}),
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

export type PublicCheckoutPayment = {
  paidAmount: number;
  due: number;
};

export interface PublicCheckoutView {
  title: string;
  items: { name: string; qty: number; price: number }[];
  total: number;
  status: string;
  createdAt: string | null;
  discount: number;
  couponCode: string;
  couponDiscount: number;
  courier: string;
  trackingNumber: string;
  brandName: string | null;
  payment: PublicCheckoutPayment | null;
  phoneVerification?: boolean;
}

export async function getPublicCheckout(
  token: string
): Promise<PublicCheckoutView | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token)
  );
  if (response === null || !response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawItems = Array.isArray(row.items) ? row.items : [];
  return {
    title: typeof row.title === "string" ? row.title : "",
    items: rawItems
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        qty: typeof item.qty === "number" ? item.qty : 1,
        price: typeof item.price === "number" ? item.price : 0,
      })),
    total: typeof row.total === "number" ? row.total : 0,
    status: typeof row.status === "string" ? row.status : "open",
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    discount: typeof row.discount === "number" ? row.discount : 0,
    couponCode: typeof row.coupon_code === "string" ? row.coupon_code : "",
    couponDiscount:
      typeof row.coupon_discount === "number" ? row.coupon_discount : 0,
    courier: typeof row.courier === "string" ? row.courier : "",
    trackingNumber:
      typeof row.tracking_number === "string" ? row.tracking_number : "",
    brandName: typeof row.brand_name === "string" ? row.brand_name : null,
    payment:
      typeof row.paid_amount === "number" && row.paid_amount > 0
        ? {
            paidAmount: row.paid_amount,
            due: typeof row.due === "number" ? row.due : 0,
          }
        : null,
  };
}

export interface SentimentResult {
  label: string;
  score: number;
  engine: "llm" | "lexicon";
  positive: string[];
  negative: string[];
}

export async function getSentiment(
  accessToken: string,
  text: string
): Promise<SentimentResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/sentiment?text=" + encodeURIComponent(text)
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
  const row = payload as Record<string, unknown>;
  return {
    label: typeof row.label === "string" ? row.label : "neutral",
    score: typeof row.score === "number" ? row.score : 0,
    engine: row.engine === "llm" ? "llm" as const : "lexicon" as const,
    positive: Array.isArray(row.positive)
      ? row.positive.filter((w): w is string => typeof w === "string")
      : [],
    negative: Array.isArray(row.negative)
      ? row.negative.filter((w): w is string => typeof w === "string")
      : [],
  };
}

export interface ChurnContact {
  contactId: string;
  name: string;
  chats: number;
  lastAt: string | null;
}

export async function listChurnRisk(
  accessToken: string,
  days: number
): Promise<ChurnContact[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/churn?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).contacts
    : null;
  if (!Array.isArray(raw)) return [];
  const contacts: ChurnContact[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    contacts.push({
      contactId: row.contact_id,
      name: typeof row.name === "string" ? row.name : "",
      chats: typeof row.chats === "number" ? row.chats : 0,
      lastAt: typeof row.last_at === "string" ? row.last_at : null,
    });
  }
  return contacts;
}

export interface StaffingForecast {
  hours: { hour: number; chats: number }[];
  peakHour: number | null;
  peakChats: number;
  suggested: number[];
}

export async function getStaffingForecast(
  accessToken: string
): Promise<StaffingForecast | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/insights/staffing");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawHours = Array.isArray(row.hours) ? row.hours : [];
  return {
    hours: rawHours
      .filter((h): h is Record<string, unknown> => h !== null && typeof h === "object")
      .map((h) => ({
        hour: typeof h.hour === "number" ? h.hour : 0,
        chats: typeof h.chats === "number" ? h.chats : 0,
      })),
    peakHour: typeof row.peak_hour === "number" ? row.peak_hour : null,
    peakChats: typeof row.peak_chats === "number" ? row.peak_chats : 0,
    suggested: Array.isArray(row.suggested)
      ? row.suggested.filter((h): h is number => typeof h === "number")
      : [],
  };
}

export interface BroadcastSuggestion {
  audience: string;
  count: number;
  note: string;
}

export async function listBroadcastSuggestions(
  accessToken: string
): Promise<BroadcastSuggestion[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/broadcast-suggestions"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).suggestions
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      audience: typeof item.audience === "string" ? item.audience : "",
      count: typeof item.count === "number" ? item.count : 0,
      note: typeof item.note === "string" ? item.note : "",
    }));
}

export interface NegotiationSettings {
  enabled: boolean;
  floorPercent: number;
  maxPercent: number;
}

export async function getNegotiationSettings(
  accessToken: string
): Promise<NegotiationSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/settings"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    floorPercent: typeof row.floor_percent === "number" ? row.floor_percent : 0,
    maxPercent: typeof row.max_percent === "number" ? row.max_percent : 25,
  };
}

export async function saveNegotiationSettings(
  accessToken: string,
  enabled: boolean,
  floorPercent: number,
  maxPercent: number
): Promise<NegotiationSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          floor_percent: floorPercent,
          max_percent: maxPercent,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    floorPercent: typeof row.floor_percent === "number" ? row.floor_percent : 0,
    maxPercent: typeof row.max_percent === "number" ? row.max_percent : 25,
  };
}

export interface NegotiationQuote {
  ask: number;
  price: number;
  discountPercent: number;
  verdict: string;
  counter: number;
  maxPercent: number;
  enabled: boolean;
}

export async function getNegotiationQuote(
  accessToken: string,
  ask: number,
  price: number
): Promise<NegotiationQuote | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/quote?ask=" +
        encodeURIComponent(String(ask)) +
        "&price=" +
        encodeURIComponent(String(price))
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
  const row = payload as Record<string, unknown>;
  return {
    ask: typeof row.ask === "number" ? row.ask : 0,
    price: typeof row.price === "number" ? row.price : 0,
    discountPercent:
      typeof row.discount_percent === "number" ? row.discount_percent : 0,
    verdict: typeof row.verdict === "string" ? row.verdict : "counter",
    counter: typeof row.counter === "number" ? row.counter : 0,
    maxPercent: typeof row.max_percent === "number" ? row.max_percent : 25,
    enabled: row.enabled === true,
  };
}

export interface CheckoutLink {
  id: number;
  token: string;
  contactId: string;
  title: string;
  items: { name: string; qty: number; price: number }[];
  total: number;
  status: string;
  createdAt: string | null;
  expiresAt: string | null;
  viewCount: number;
  paidAmount: number;
  discount: number;
  courier: string;
  trackingNumber: string;
  brandId: number | null;
  brandName: string | null;
}

export async function createCheckoutLink(
  accessToken: string,
  contactId: string,
  title: string,
  items: { name: string; qty: number; price: number }[],
  expiresInDays?: number | null,
  discountAmount?: number | null,
  advancePercent?: number | null,
  brandId?: number | null
): Promise<CheckoutLink | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          title,
          items: items.map((item) => ({
            name: item.name,
            qty: item.qty,
            price: item.price,
          })),
          expires_in_days: expiresInDays ?? null,
          discount_amount: discountAmount ?? null,
          advance_percent: advancePercent ?? null,
          brand_id: brandId ?? null,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).link
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const rawItems = Array.isArray(row.items) ? row.items : [];
  return {
    id: typeof row.id === "number" ? row.id : 0,
    token: typeof row.token === "string" ? row.token : "",
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    title: typeof row.title === "string" ? row.title : "",
    items: rawItems
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        qty: typeof item.qty === "number" ? item.qty : 1,
        price: typeof item.price === "number" ? item.price : 0,
      })),
    total: typeof row.total === "number" ? row.total : 0,
    status: typeof row.status === "string" ? row.status : "open",
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    viewCount: typeof row.view_count === "number" ? row.view_count : 0,
    paidAmount: typeof row.paid_amount === "number" ? row.paid_amount : 0,
    discount: typeof row.discount === "number" ? row.discount : 0,
    courier: typeof row.courier === "string" ? row.courier : "",
    trackingNumber:
      typeof row.tracking_number === "string" ? row.tracking_number : "",
    brandId: typeof row.brand_id === "number" ? row.brand_id : null,
    brandName: typeof row.brand_name === "string" ? row.brand_name : null,
  };
}

export async function listCheckoutLinks(
  accessToken: string
): Promise<CheckoutLink[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/checkout/links");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).links
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => {
      const rawItems = Array.isArray(item.items) ? item.items : [];
      return {
        id: typeof item.id === "number" ? item.id : 0,
        token: typeof item.token === "string" ? item.token : "",
        contactId: typeof item.contact_id === "string" ? item.contact_id : "",
        title: typeof item.title === "string" ? item.title : "",
        items: rawItems
          .filter((entry): entry is Record<string, unknown> =>
            entry !== null && typeof entry === "object")
          .map((entry) => ({
            name: typeof entry.name === "string" ? entry.name : "",
            qty: typeof entry.qty === "number" ? entry.qty : 1,
            price: typeof entry.price === "number" ? entry.price : 0,
          })),
        total: typeof item.total === "number" ? item.total : 0,
        status: typeof item.status === "string" ? item.status : "open",
        createdAt: typeof item.created_at === "string" ? item.created_at : null,
        expiresAt: typeof item.expires_at === "string" ? item.expires_at : null,
        viewCount: typeof item.view_count === "number" ? item.view_count : 0,
        paidAmount: typeof item.paid_amount === "number" ? item.paid_amount : 0,
        discount: typeof item.discount === "number" ? item.discount : 0,
        courier: typeof item.courier === "string" ? item.courier : "",
        trackingNumber:
          typeof item.tracking_number === "string" ? item.tracking_number : "",
        brandId: typeof item.brand_id === "number" ? item.brand_id : null,
        brandName:
          typeof item.brand_name === "string" ? item.brand_name : null,
      };
    });
}

export type CheckoutStatusMutation = { ok: true } | "not_found"
  | "forbidden"
  | null;

export async function setCheckoutLinkStatus(
  accessToken: string,
  linkId: number,
  status: string,
  returnReason?: string
): Promise<CheckoutStatusMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason: returnReason, note: "" }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 403) return "forbidden";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface CheckoutNotifySettings {
  notifyEnabled: boolean;
  tplPaid: string;
  tplShipped: string;
  tplDelivered: string;
  tplReturned: string;
  cartEnabled: boolean;
  cartGap1: number;
  cartGap2: number;
  cartGap3: number;
  cartTpl1: string;
  cartTpl2: string;
  cartTpl3: string;
}

function normalizeCart(raw: Record<string, unknown>): {
  cartEnabled: boolean;
  cartGap1: number;
  cartGap2: number;
  cartGap3: number;
  cartTpl1: string;
  cartTpl2: string;
  cartTpl3: string;
} {
  const gap = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value)
      && value >= 1 && value <= 168
      ? Math.floor(value)
      : fallback;
  return {
    cartEnabled: raw.enabled === true,
    cartGap1: gap(raw.gap_1, 2),
    cartGap2: gap(raw.gap_2, 24),
    cartGap3: gap(raw.gap_3, 48),
    cartTpl1: typeof raw.tpl_1 === "string" ? raw.tpl_1 : "",
    cartTpl2: typeof raw.tpl_2 === "string" ? raw.tpl_2 : "",
    cartTpl3: typeof raw.tpl_3 === "string" ? raw.tpl_3 : "",
  };
}

export async function getCheckoutNotifySettings(
  accessToken: string
): Promise<CheckoutNotifySettings | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/settings"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const cartRaw = s.cart !== null && typeof s.cart === "object"
    ? (s.cart as Record<string, unknown>)
    : {};
  return {
    notifyEnabled: s.notify_enabled === true,
    tplPaid: typeof s.tpl_paid === "string" ? s.tpl_paid : "",
    tplShipped: typeof s.tpl_shipped === "string" ? s.tpl_shipped : "",
    tplDelivered: typeof s.tpl_delivered === "string" ? s.tpl_delivered : "",
    tplReturned: typeof s.tpl_returned === "string" ? s.tpl_returned : "",
    ...normalizeCart(cartRaw),
  };
}

export async function saveCheckoutNotifySettings(
  accessToken: string,
  settings: CheckoutNotifySettings
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            notify_enabled: settings.notifyEnabled === true,
            tpl_paid: String(settings.tplPaid || "").trim().slice(0, 500),
            tpl_shipped: String(settings.tplShipped || "").trim().slice(0, 500),
            tpl_delivered: String(settings.tplDelivered || "").trim().slice(0, 500),
            tpl_returned: String(settings.tplReturned || "").trim().slice(0, 500),
            cart: {
              enabled: settings.cartEnabled === true,
              gap_1: Number(settings.cartGap1) >= 1
                && Number(settings.cartGap1) <= 168
                ? Math.floor(Number(settings.cartGap1)) : 2,
              gap_2: Number(settings.cartGap2) >= 1
                && Number(settings.cartGap2) <= 168
                ? Math.floor(Number(settings.cartGap2)) : 24,
              gap_3: Number(settings.cartGap3) >= 1
                && Number(settings.cartGap3) <= 168
                ? Math.floor(Number(settings.cartGap3)) : 48,
              tpl_1: String(settings.cartTpl1 || "").trim().slice(0, 500),
              tpl_2: String(settings.cartTpl2 || "").trim().slice(0, 500),
              tpl_3: String(settings.cartTpl3 || "").trim().slice(0, 500),
            },
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface CheckoutReturn {
  id: number;
  linkId: number;
  reason: string;
  note: string;
  title: string;
  total: number;
  createdAt: string | null;
}

export async function listCheckoutReturns(
  accessToken: string
): Promise<{ returns: CheckoutReturn[]; total: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/returns"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).returns
    : null;
  if (!Array.isArray(raw)) return { returns: [], total: 0 };
  const returns = raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      linkId: typeof item.link_id === "number" ? item.link_id : 0,
      reason: typeof item.reason === "string" ? item.reason : "other",
      note: typeof item.note === "string" ? item.note : "",
      title: typeof item.title === "string" ? item.title : "",
      total: typeof item.total === "number" ? item.total : 0,
      createdAt: typeof item.created_at === "string" ? item.created_at : null,
    }));
  const counts = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).counts
    : null;
  const total = counts !== null && typeof counts === "object"
    && typeof (counts as Record<string, unknown>).total === "number"
    ? (counts as Record<string, unknown>).total as number
    : returns.length;
  return { returns, total };
}

export interface DigestSettings {
  enabled: boolean;
  ownerContact: string;
  hour: number;
}

export async function getDigestSettings(
  accessToken: string
): Promise<DigestSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/digest/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    enabled: s.enabled === true,
    ownerContact: typeof s.owner_contact === "string" ? s.owner_contact : "",
    hour: typeof s.hour === "number" && s.hour >= 6 && s.hour <= 21
      ? Math.floor(s.hour)
      : 9,
  };
}

export async function saveDigestSettings(
  accessToken: string,
  settings: DigestSettings
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/digest/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            enabled: settings.enabled === true,
            owner_contact: String(settings.ownerContact || "").trim().slice(0, 100),
            hour: Number(settings.hour) >= 6 && Number(settings.hour) <= 21
              ? Math.floor(Number(settings.hour))
              : 9,
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export type CheckoutEditMutation =
  | { ok: true; total: number }
  | "not_found"
  | "bad_request"
  | null;

export async function editCheckoutLink(
  accessToken: string,
  linkId: number,
  title: string,
  items: { name: string; qty: number; price: number }[],
  expiresInDays?: number | null,
  discountAmount?: number | null
): Promise<CheckoutEditMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/edit",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          items,
          expires_in_days: expiresInDays ?? null,
          discount_amount: discountAmount ?? null,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const total = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).total
    : null;
  return {
    ok: true,
    total: typeof total === "number" ? total : 0,
  };
}

export type CheckoutDuplicate =
  | { ok: true; token: string }
  | "not_found"
  | null;

export async function duplicateCheckoutLink(
  accessToken: string,
  linkId: number
): Promise<CheckoutDuplicate> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/duplicate",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).link
    : null;
  const token = raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>).token
    : null;
  return {
    ok: true,
    token: typeof token === "string" ? token : "",
  };
}

export interface PaymentSettings {
  provider: string;
  enabled: boolean;
  sandbox: boolean;
  configured: boolean;
  merchantIdMask: string;
  storeIdMask: string;
}

export async function fetchPublicPayHtml(
  token: string
): Promise<{ status: number; html: string } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/pay"
  );
  if (response === null) return null;
  const html = await response.text().catch(() => "");
  return { status: response.status, html };
}

export async function getPublicPayInfo(
  token: string
): Promise<{ enabled: boolean; due: number } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/payinfo"
  );
  if (response === null || !response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    due: typeof row.due === "number" ? row.due : 0,
  };
}

export async function getPaymentSettings(
  accessToken: string
): Promise<PaymentSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/payments/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).settings;
  if (row === null || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  return {
    provider: typeof data.provider === "string" ? data.provider : "jazzcash",
    enabled: data.enabled === true,
    sandbox: data.sandbox === true,
    configured: data.configured === true,
    merchantIdMask:
      typeof data.merchant_id_masked === "string"
        ? data.merchant_id_masked
        : "****",
    storeIdMask:
      typeof data.store_id_masked === "string" ? data.store_id_masked : "****",
  };
}

export async function savePaymentSettings(
  accessToken: string,
  input: {
    provider: string;
    enabled: boolean;
    sandbox: boolean;
    merchantId: string;
    password: string;
    salt: string;
    storeId: string;
  }
): Promise<{ ok: true } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/payments/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: input.provider,
        enabled: input.enabled,
        sandbox: input.sandbox,
        merchant_id: input.merchantId,
        password: input.password,
        salt: input.salt,
        store_id: input.storeId,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface CustomerAnalyticsEntry {
  contactId: string;
  orders: number;
  spend: number;
  avgOrder: number;
  tier: string;
  lastOrder: string | null;
}

export interface ProductAnalyticsEntry {
  name: string;
  qtySold: number;
  revenue: number;
  orders: number;
}

export interface CustomerLanguageCount {
  lang: string;
  count: number;
}

export async function getCustomerAnalytics(
  accessToken: string,
  days: number
): Promise<{
  customers: CustomerAnalyticsEntry[];
  tiers: Record<string, number>;
  repeatShare: number;
  languages: CustomerLanguageCount[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/customer-analytics?days=" + days
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawCustomers = Array.isArray(row.customers) ? row.customers : [];
  const rawTiers =
    row.tiers !== null && typeof row.tiers === "object"
      ? (row.tiers as Record<string, unknown>)
      : {};
  return {
    customers: rawCustomers
      .filter((entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object")
      .map((entry) => ({
        contactId:
          typeof entry.contact_id === "string" ? entry.contact_id : "",
        orders: typeof entry.orders === "number" ? entry.orders : 0,
        spend: typeof entry.spend === "number" ? entry.spend : 0,
        avgOrder: typeof entry.avg_order === "number" ? entry.avg_order : 0,
        tier: typeof entry.tier === "string" ? entry.tier : "new",
        lastOrder:
          typeof entry.last_order === "string" ? entry.last_order : null,
      })),
    tiers: {
      new: typeof rawTiers.new === "number" ? rawTiers.new : 0,
      repeat: typeof rawTiers.repeat === "number" ? rawTiers.repeat : 0,
      vip: typeof rawTiers.vip === "number" ? rawTiers.vip : 0,
    },
    repeatShare: typeof row.repeat_share === "number" ? row.repeat_share : 0,
    languages: (Array.isArray(row.languages) ? row.languages : [])
      .filter((entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object")
      .map((entry) => ({
        lang: typeof entry.lang === "string" ? entry.lang : "",
        count: typeof entry.count === "number" ? entry.count : 0,
      })),
  };
}

export async function getProductAnalytics(
  accessToken: string,
  days: number
): Promise<ProductAnalyticsEntry[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/product-analytics?days=" + days
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = Array.isArray(
    (payload as Record<string, unknown>).products
  )
    ? ((payload as Record<string, unknown>).products as unknown[])
    : [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      qtySold: typeof entry.qty_sold === "number" ? entry.qty_sold : 0,
      revenue: typeof entry.revenue === "number" ? entry.revenue : 0,
      orders: typeof entry.orders === "number" ? entry.orders : 0,
    }));
}

export interface RetentionSettings {
  closeIdleDays: number;
  purgeRejectedDays: number;
}

export async function getRetention(
  accessToken: string
): Promise<RetentionSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/data/retention");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).retention;
  if (row === null || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  return {
    closeIdleDays:
      typeof data.close_idle_days === "number" ? data.close_idle_days : 14,
    purgeRejectedDays:
      typeof data.purge_rejected_days === "number"
        ? data.purge_rejected_days
        : 30,
  };
}

export async function saveRetention(
  accessToken: string,
  closeIdleDays: number,
  purgeRejectedDays: number
): Promise<RetentionSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/data/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        close_idle_days: closeIdleDays,
        purge_rejected_days: purgeRejectedDays,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).retention;
  if (row === null || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  return {
    closeIdleDays:
      typeof data.close_idle_days === "number" ? data.close_idle_days : 14,
    purgeRejectedDays:
      typeof data.purge_rejected_days === "number"
        ? data.purge_rejected_days
        : 30,
  };
}

export async function runRetention(
  accessToken: string
): Promise<{ closed: number; purged: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/data/retention/run",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    closed: typeof row.closed === "number" ? row.closed : 0,
    purged: typeof row.purged === "number" ? row.purged : 0,
  };
}

export async function fetchDataExport(
  accessToken: string
): Promise<{ status: number; body: string; filename: string | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/data/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  const body = await response.text().catch(() => "");
  const disposition = response.headers.get("content-disposition");
  const match = disposition
    ? /filename="([^"]+)"/.exec(disposition)
    : null;
  return { status: response.status, body, filename: match ? match[1] : null };
}

export interface InteractiveTemplate {
  id: number | null;
  name: string;
  kind: string;
  header: string;
  body: string;
  footer: string;
  rows: { title: string; description?: string }[];
  listLabel: string;
  createdAt: string | null;
}

export async function listInteractiveTemplates(
  accessToken: string
): Promise<InteractiveTemplate[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/interactive/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = Array.isArray((payload as Record<string, unknown>).templates)
    ? ((payload as Record<string, unknown>).templates as unknown[])
    : [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object")
    .map((entry) => {
      const rawRows = Array.isArray(entry.rows) ? entry.rows : [];
      return {
        id: typeof entry.id === "number" ? entry.id : null,
        name: typeof entry.name === "string" ? entry.name : "",
        kind: typeof entry.kind === "string" ? entry.kind : "buttons",
        header: typeof entry.header === "string" ? entry.header : "",
        body: typeof entry.body === "string" ? entry.body : "",
        footer: typeof entry.footer === "string" ? entry.footer : "",
        rows: rawRows
          .filter((row): row is Record<string, unknown> =>
            row !== null && typeof row === "object")
          .map((row) => ({
            title: typeof row.title === "string" ? row.title : "",
            description:
              typeof row.description === "string" ? row.description : undefined,
          }))
          .filter((row) => row.title !== ""),
        listLabel: typeof entry.list_label === "string" ? entry.list_label : "",
        createdAt:
          typeof entry.created_at === "string" ? entry.created_at : null,
      };
    });
}

export interface InteractiveTemplateInput {
  name: string;
  kind: string;
  header: string;
  body: string;
  footer: string;
  listLabel: string;
  rows: { title: string; description?: string }[];
}

function interactiveTemplateBody(input: InteractiveTemplateInput): string {
  return JSON.stringify({
    name: input.name,
    kind: input.kind,
    header: input.header,
    body: input.body,
    footer: input.footer,
    list_label: input.listLabel,
    rows: input.rows.map((row) => ({
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
    })),
  });
}

export async function createInteractiveTemplate(
  accessToken: string,
  input: InteractiveTemplateInput
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/interactive/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: interactiveTemplateBody(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export async function updateInteractiveTemplate(
  accessToken: string,
  templateId: number,
  input: InteractiveTemplateInput
): Promise<{ ok: true } | "not_found" | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/interactive/templates/" + templateId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: interactiveTemplateBody(input),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export async function deleteInteractiveTemplate(
  accessToken: string,
  templateId: number
): Promise<{ ok: true } | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/interactive/templates/" + templateId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export type InteractiveSendResult =
  | { ok: true; kind: string }
  | "not_found"
  | "bad_request"
  | null;

export async function sendInteractiveTemplate(
  accessToken: string,
  conversationId: number,
  templateId: number
): Promise<InteractiveSendResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/interactive/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        template_id: templateId,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true, kind: typeof row.kind === "string" ? row.kind : "buttons" };
}

export interface InstagramSettings {
  accountId: string;
  pageId: string;
  enabled: boolean;
  configured: boolean;
  messengerEnabled: boolean;
  commentsEnabled: boolean;
  commentAutoReply: boolean;
  pageAccessTokenMasked: string;
  webhookPath: string;
  accessTokenMasked: string;
  appSecretMasked: string;
  verifyTokenMasked: string;
  lastCheckAt: string | null;
  lastError: string | null;
}

export async function getInstagramSettings(
  accessToken: string
): Promise<InstagramSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/instagram/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = ((payload as Record<string, unknown>).settings || {}) as Record<string, unknown>;
  return {
    accountId: typeof row.accountId === "string" ? row.accountId : "",
    pageId: typeof row.pageId === "string" ? row.pageId : "",
    enabled: row.enabled === true,
    configured: row.configured === true,
    messengerEnabled: row.messengerEnabled === true,
    commentsEnabled: row.commentsEnabled === true,
    commentAutoReply: row.commentAutoReply === true,
    pageAccessTokenMasked:
      typeof row.pageAccessTokenMasked === "string" ? row.pageAccessTokenMasked : "",
    webhookPath: typeof row.webhookPath === "string" ? row.webhookPath : "/api/v1/public/meta/webhook",
    accessTokenMasked: typeof row.accessTokenMasked === "string" ? row.accessTokenMasked : "",
    appSecretMasked: typeof row.appSecretMasked === "string" ? row.appSecretMasked : "",
    verifyTokenMasked: typeof row.verifyTokenMasked === "string" ? row.verifyTokenMasked : "",
    lastCheckAt: typeof row.lastCheckAt === "string" ? row.lastCheckAt : null,
    lastError: typeof row.lastError === "string" ? row.lastError : null,
  };
}

export async function saveInstagramSettings(
  accessToken: string,
  input: {
    enabled: boolean;
    accountId: string;
    pageId: string;
    accessTokenValue: string;
    appSecret: string;
    verifyToken: string;
    pageAccessToken: string;
    messengerEnabled: boolean;
    commentsEnabled: boolean;
    commentAutoReply: boolean;
  }
): Promise<{ ok: true; requiresCheck: boolean } | { invalid: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/instagram/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: input.enabled,
        account_id: input.accountId,
        page_id: input.pageId,
        access_token: input.accessTokenValue,
        app_secret: input.appSecret,
        verify_token: input.verifyToken,
        page_access_token: input.pageAccessToken,
        messenger_enabled: input.messengerEnabled,
        comments_enabled: input.commentsEnabled,
        comment_auto_reply: input.commentAutoReply,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400 || response.status === 409) {
    // the Control Plane's own sentence ("Messenger needs the Facebook Page ID.")
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
    const message =
      error && typeof error === "object" ? (error as Record<string, unknown>).message : null;
    return { invalid: typeof message === "string" && message ? message : "Check the Meta settings." };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return {
    ok: true,
    requiresCheck: row.requires_check !== false,
  };
}

export async function verifyInstagramSettings(
  accessToken: string
): Promise<
  | { ok: true; profile: { id: string; username: string }; page: { id: string; name: string } | null }
  | "not_configured"
  | { providerError: string }
  | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/instagram/test", {
      method: "POST",
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) return "not_configured";
  if (response.status === 502) {
    // Meta's own reason (expired token, missing permission) helps the owner
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
    const message =
      error && typeof error === "object" ? (error as Record<string, unknown>).message : null;
    return {
      providerError:
        typeof message === "string" && message ? message.slice(0, 300) : "Meta rejected the provider check.",
    };
  }
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const pageRow =
    row.page !== null && typeof row.page === "object" ? (row.page as Record<string, unknown>) : null;
  const profile = row.profile;
  const p = profile !== null && typeof profile === "object"
    ? (profile as Record<string, unknown>)
    : {};
  if (row.ok !== true) return null;
  return {
    ok: true,
    profile: {
      id: typeof p.id === "string" ? p.id : "",
      username: typeof p.username === "string" ? p.username : "",
    },
    page: pageRow
      ? {
          id: typeof pageRow.id === "string" ? pageRow.id : "",
          name: typeof pageRow.name === "string" ? pageRow.name : "",
        }
      : null,
  };
}

export interface WatiSettings {
  enabled: boolean;
  baseUrl: string;
  tokenMasked: string;
  configured: boolean;
}

export async function getWatiSettings(
  accessToken: string
): Promise<WatiSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = ((payload as Record<string, unknown>).settings || {}) as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    baseUrl: typeof row.baseUrl === "string" ? row.baseUrl : "",
    tokenMasked: typeof row.tokenMasked === "string" ? row.tokenMasked : "",
    configured: row.configured === true,
  };
}

export async function saveWatiSettings(
  accessToken: string,
  input: { enabled: boolean; baseUrl: string; apiToken: string }
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: input.enabled,
        base_url: input.baseUrl,
        api_token: input.apiToken,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export async function syncWatiTemplates(
  accessToken: string
): Promise<{ ok: true; count: number } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/sync", {
      method: "POST",
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true, count: typeof row.count === "number" ? row.count : 0 };
}

export async function listWatiTemplates(
  accessToken: string
): Promise<{ name: string; data: Record<string, unknown> }[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = Array.isArray((payload as Record<string, unknown>).templates)
    ? ((payload as Record<string, unknown>).templates as unknown[])
    : [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      data:
        entry.data !== null && typeof entry.data === "object"
          ? (entry.data as Record<string, unknown>)
          : {},
    }))
    .filter((entry) => entry.name !== "");
}

export async function sendWatiTemplate(
  accessToken: string,
  conversationId: number,
  templateName: string,
  parameters: string[]
): Promise<{ ok: true } | "not_found" | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        template_name: templateName,
        parameters: parameters.map((value, index) => ({
          name: String(index + 1),
          value,
        })),
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  if ((payload as Record<string, unknown>).ok !== true) return null;
  return { ok: true };
}

export interface ChangeRequest {
  id: number;
  linkId: number;
  kind: "address" | "cancel";
  message: string;
  addressText: string;
  status: "pending" | "approved" | "declined";
  createdAt: string | null;
  decidedAt: string | null;
  title: string;
}

function mapChangeRequest(raw: Record<string, unknown>): ChangeRequest {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    linkId: typeof raw.linkId === "number" ? raw.linkId : 0,
    kind: raw.kind === "cancel" ? "cancel" : "address",
    message: typeof raw.message === "string" ? raw.message : "",
    addressText: typeof raw.addressText === "string" ? raw.addressText : "",
    status:
      raw.status === "approved"
        ? "approved"
        : raw.status === "declined"
          ? "declined"
          : "pending",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
    title: typeof raw.title === "string" ? raw.title : "",
  };
}

export async function listChangeRequests(
  accessToken: string,
  statusFilter: "pending" | "approved" | "declined" | "all"
): Promise<{ requests: ChangeRequest[]; counts: Record<string, number> } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/changes/requests?status=" + statusFilter
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    requests?: unknown;
    counts?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.requests)) return null;
  const counts: Record<string, number> = {};
  if (payload.counts && typeof payload.counts === "object") {
    for (const [key, value] of Object.entries(
      payload.counts as Record<string, unknown>
    )) {
      if (typeof value === "number") counts[key] = value;
    }
  }
  return {
    requests: payload.requests
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map(mapChangeRequest),
    counts,
  };
}

export async function decideChangeRequest(
  accessToken: string,
  requestId: number,
  action: "approve" | "decline"
): Promise<{ ok: true; request: ChangeRequest } | "bad_request" | "conflict" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/changes/requests/" + requestId + "/decide",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return "bad_request";
  if (response.status === 409) return "conflict";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    request?: unknown;
  } | null;
  if (!payload || !payload.request || typeof payload.request !== "object") {
    return null;
  }
  return {
    ok: true,
    request: mapChangeRequest(payload.request as Record<string, unknown>),
  };
}

export async function submitChangeRequest(
  token: string,
  input: { kind: "address" | "cancel"; message: string; addressText: string }
): Promise<{ ok: true } | { error: { message: string } } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/change-request",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: input.kind,
        message: input.message,
        address_text: input.addressText,
      }),
    }
  );
  if (response === null) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null) return null;
  if (!response.ok) {
    const error =
      payload.error !== null && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : {};
    return {
      error: { message: typeof error.message === "string" ? error.message : "" },
    };
  }
  return { ok: true };
}

export interface Coupon {
  id: number;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  minTotal: number;
  usageLimit: number | null;
  usedCount: number;
  expiresAt: string | null;
  isActive: boolean;
}

function mapCoupon(raw: Record<string, unknown>): Coupon {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    code: typeof raw.code === "string" ? raw.code : "",
    kind: raw.kind === "percent" ? "percent" : "fixed",
    value: typeof raw.value === "number" ? raw.value : 0,
    minTotal: typeof raw.minTotal === "number" ? raw.minTotal : 0,
    usageLimit: typeof raw.usageLimit === "number" ? raw.usageLimit : null,
    usedCount: typeof raw.usedCount === "number" ? raw.usedCount : 0,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    isActive: raw.isActive === true,
  };
}

export async function listCoupons(
  accessToken: string
): Promise<{ coupons: Coupon[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/coupons");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    coupons?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.coupons)) return null;
  return {
    coupons: payload.coupons
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map(mapCoupon),
  };
}

export type CouponInput = {
  code: string;
  kind: "percent" | "fixed";
  value: number;
  min_total?: number;
  usage_limit?: number | null;
  expires_in_days?: number | null;
};

export async function createCoupon(
  accessToken: string,
  input: CouponInput
): Promise<{ ok: true; coupon: Coupon } | { error: string } | "conflict" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/coupons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) return "conflict";
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return { error: payload?.error?.message || "Check the coupon details." };
  }
  const payload = (await response.json().catch(() => null)) as {
    coupon?: unknown;
  } | null;
  if (!payload || !payload.coupon || typeof payload.coupon !== "object") {
    return null;
  }
  return {
    ok: true,
    coupon: mapCoupon(payload.coupon as Record<string, unknown>),
  };
}

export async function setCouponActive(
  accessToken: string,
  couponId: number,
  isActive: boolean
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/coupons/" + couponId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCoupon(
  accessToken: string,
  couponId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/coupons/" + couponId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface PublicStoreItem {
  id: number;
  kind: string;
  name: string;
  priceText: string;
  notes: string;
  price: number;
  imageUrl: string;
}

export interface PublicStoreView {
  brand: { name: string; slug: string };
  items: PublicStoreItem[];
}

export async function getPublicStore(
  slug: string
): Promise<PublicStoreView | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/store/" + encodeURIComponent(slug)
  );
  if (response === null || !response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = payload as {
    brand?: Record<string, unknown>;
    items?: unknown;
  };
  if (!raw.brand || !Array.isArray(raw.items)) return null;
  return {
    brand: {
      name: String(raw.brand.name || ""),
      slug: String(raw.brand.slug || slug),
    },
    items: raw.items
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        id: Number(item.id || 0),
        kind: String(item.kind || "product"),
        name: String(item.name || ""),
        priceText: String(item.price_text || ""),
        notes: String(item.notes || ""),
        price: Number(item.price || 0),
        imageUrl: String(item.image_url || ""),
      })),
  };
}

export type PublicStoreOrderResult =
  | { ok: true; url: string }
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | null;

export async function orderFromStore(
  slug: string,
  phone: string,
  name: string,
  itemId: number
): Promise<PublicStoreOrderResult> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/store/" + encodeURIComponent(slug) + "/order",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, name, item_id: itemId }),
    }
  );
  if (response === null) return null;
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 429) return "rate_limited";
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  if (raw.ok !== true || typeof raw.url !== "string") return null;
  return { ok: true, url: raw.url };
}

export type PublicPhoneOtpResult =
  | { ok: true; sent: true }
  | "not_found"
  | "feature_off"
  | "rate_limited"
  | null;

export async function requestPublicPhoneOtp(
  token: string
): Promise<PublicPhoneOtpResult> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/otp",
    { method: "POST" }
  );
  if (response === null) return null;
  if (response.status === 404) return "not_found";
  if (response.status === 409) return "feature_off";
  if (response.status === 429) return "rate_limited";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null || payload.ok !== true) return null;
  return { ok: true, sent: true };
}

export type PublicPhoneOtpVerifyResult =
  | { ok: true; verified: true }
  | "not_found"
  | "feature_off"
  | "rate_limited"
  | "bad_code"
  | null;

export async function verifyPublicPhoneOtp(
  token: string,
  code: string
): Promise<PublicPhoneOtpVerifyResult> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/otp/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }
  );
  if (response === null) return null;
  if (response.status === 404) return "not_found";
  if (response.status === 409) return "feature_off";
  if (response.status === 429) return "rate_limited";
  if (response.status === 400) return "bad_code";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null || payload.verified !== true) return null;
  return { ok: true, verified: true };
}

export async function applyPublicCoupon(
  token: string,
  code: string
): Promise<
  | { ok: true; total: number; discount: number; code: string }
  | { error: string }
  | null
> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/coupon",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }
  );
  if (response === null) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null) return null;
  if (!response.ok) {
    const error =
      payload.error !== null && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : {};
    return {
      error: typeof error.message === "string" ? error.message : "",
    };
  }
  return {
    ok: true,
    total: typeof payload.total === "number" ? payload.total : 0,
    discount: typeof payload.discount === "number" ? payload.discount : 0,
    code: typeof payload.code === "string" ? payload.code : "",
  };
}

export async function removePublicCoupon(
  token: string
): Promise<{ ok: true; total: number } | { error: string } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/coupon",
    { method: "DELETE" }
  );
  if (response === null) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null) return null;
  if (!response.ok) {
    const error =
      payload.error !== null && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : {};
    return {
      error: typeof error.message === "string" ? error.message : "",
    };
  }
  return { ok: true, total: typeof payload.total === "number" ? payload.total : 0 };
}

export interface CloudTemplate {
  id: number;
  name: string;
  language: string;
  status: string;
  category: string;
}

export async function getCloudTemplates(
  accessToken: string
): Promise<{ templates: CloudTemplate[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cloud/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    templates?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.templates)) return null;
  return {
    templates: payload.templates
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map((row) => ({
        id: typeof row.id === "number" ? row.id : 0,
        name: typeof row.name === "string" ? row.name : "",
        language: typeof row.language === "string" ? row.language : "",
        status: typeof row.status === "string" ? row.status : "",
        category: typeof row.category === "string" ? row.category : "",
      })),
  };
}

export async function sendCloudTemplate(
  accessToken: string,
  input: {
    conversationId: number;
    templateName: string;
    languageCode: string;
    parameters: string[];
  }
): Promise<{ ok: true; template: string } | "bad_request" | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cloud/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: input.conversationId,
        template_name: input.templateName,
        language_code: input.languageCode,
        parameters: input.parameters,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return "bad_request";
  if (response.status === 404) return "not_found";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    template?: unknown;
  } | null;
  return {
    ok: true,
    template: typeof payload?.template === "string" ? payload.template : "",
  };
}

// ---------------------------------------------------------------------------
// Deliveries (event core: failed command queue + dead letters)
// ---------------------------------------------------------------------------

export type DeliveryStatus = "pending" | "failed" | "dead" | "done";

export interface DeliveryRow {
  id: number;
  kind: string;
  label: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  channel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeliveriesPayload {
  deliveries: DeliveryRow[];
  counts: Record<DeliveryStatus, number>;
}

function mapDeliveryRow(row: Record<string, unknown>): DeliveryRow {
  return {
    id: typeof row.id === "number" ? row.id : 0,
    kind: typeof row.kind === "string" ? row.kind : "command",
    label: typeof row.label === "string" ? row.label : "",
    status: typeof row.status === "string" ? row.status : "",
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    nextAttemptAt: typeof row.nextAttemptAt === "string" ? row.nextAttemptAt : null,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : null,
    providerMessageId:
      typeof row.providerMessageId === "string" ? row.providerMessageId : null,
    channel: typeof row.channel === "string" ? row.channel : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
  };
}

export async function listDeliveries(
  accessToken: string,
  status?: DeliveryStatus
): Promise<DeliveriesPayload | null> {
  let response: Response;
  try {
    const query = status ? "?status=" + encodeURIComponent(status) : "";
    response = await portalRequest(
      accessToken,
      "api/v1/portal/deliveries" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    deliveries?: unknown;
    counts?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.deliveries)) return null;
  const counts = (payload.counts ?? {}) as Record<string, unknown>;
  return {
    deliveries: payload.deliveries
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map(mapDeliveryRow),
    counts: {
      pending: typeof counts.pending === "number" ? counts.pending : 0,
      failed: typeof counts.failed === "number" ? counts.failed : 0,
      dead: typeof counts.dead === "number" ? counts.dead : 0,
      done: typeof counts.done === "number" ? counts.done : 0,
    },
  };
}

export interface GrowthBundlePayload {
  segments?: Record<string, unknown> | null;
  trends?:
    | Record<string, { day: string | null; value: number }[]>
    | null;
  days?: number;
  generated_at?: string;
}

export async function getGrowthBundle(
  accessToken: string,
  days: number
): Promise<GrowthBundlePayload | "bundle_disabled" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/growth-bundle?days=" +
        encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 503) return "bundle_disabled";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as
    | GrowthBundlePayload
    | null;
  return payload;
}

export interface PortalAlert {
  id: number;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  is_read: boolean;
  created_at: string | null;
}

export interface AlertsPayload {
  alerts: PortalAlert[];
  unread: number;
}

export async function listAlerts(
  accessToken: string
): Promise<AlertsPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/alerts");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AlertsPayload | null;
}

export async function markAlertsRead(
  accessToken: string,
  id?: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/alerts/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(id ? { id } : { all: true }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function putAlertSettings(
  accessToken: string,
  enabled: boolean
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/alerts/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface BrainSettings {
  autonomy: "off" | "suggest" | "auto";
  tone: string;
  /** Platform controls applied on top of the workspace setting (read-only). */
  platform?: {
    paused: boolean;
    autonomy_cap: "off" | "suggest" | "auto";
    daily_call_cap: number;
    effective_autonomy: "off" | "suggest" | "auto";
  };
}

export interface BrainDraftResult {
  decision: string;
  draft: string;
  grounding: Record<string, unknown> | null;
  autonomy?: string;
  kbEntry?: { title: string; content: string } | null;
}

export async function getBrainSettings(
  accessToken: string
): Promise<BrainSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    settings?: BrainSettings;
  } | null;
  return payload?.settings ?? null;
}

export async function putBrainSettings(
  accessToken: string,
  settings: BrainSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function draftBrainReply(
  accessToken: string,
  conversationId: number
): Promise<BrainDraftResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const result = payload as BrainDraftResult & {
    kb_entry?: unknown;
  };
  const rawEntry = result.kb_entry;
  const kbEntry =
    rawEntry !== null && typeof rawEntry === "object"
      ? {
          title: String(
            (rawEntry as Record<string, unknown>).title || "Saved answer"
          ),
          content: String((rawEntry as Record<string, unknown>).content || ""),
        }
      : null;
  return { ...result, kbEntry };
}

export async function listBrainTraces(
  accessToken: string,
  conversationId?: number
): Promise<{ traces: Record<string, unknown>[] } | null> {
  let response: Response;
  try {
    const query = conversationId
      ? "?conversation_id=" + encodeURIComponent(String(conversationId))
      : "";
    response = await portalRequest(accessToken, "api/v1/portal/brain/trace" + query);
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    traces: Record<string, unknown>[];
  } | null;
}

export interface MemoryEntry {
  id: number;
  kind: "preference" | "note" | "fact";
  content: string;
  created_by: string;
  mtype: "short" | "long" | "business" | "journey";
  source: "owner" | "ai" | "automation";
  confidence: number;
  expires_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface JourneyStage {
  id: number;
  name: string;
  position: number;
  is_active: boolean;
}

export interface JourneyEvent {
  stage_name: string;
  source: string;
  created_at: string | null;
}

export interface JourneySnapshot {
  stages: JourneyStage[];
  current: { stage_id: number; name: string; updated_at: string } | null;
  events: JourneyEvent[];
}

export interface ExplainActivity {
  action: string;
  actor_kind: string;
  note: string;
  created_at: string | null;
}

export async function listCustomerMemory(
  accessToken: string,
  contact: string
): Promise<{ memory: MemoryEntry[]; cap: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/memory?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    memory: MemoryEntry[];
    cap: number;
  } | null;
}

export async function addCustomerMemory(
  accessToken: string,
  contact: string,
  kind: MemoryEntry["kind"],
  content: string,
  mtype: MemoryEntry["mtype"] = "long",
  expiresHours = 0
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact,
        kind,
        content,
        mtype,
        expires_hours: expiresHours,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function updateCustomerMemory(
  accessToken: string,
  id: number,
  content: string,
  mtype?: MemoryEntry["mtype"],
  expiresHours?: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        mtype,
        expires_hours: expiresHours,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCustomerMemory(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory/" + id, {
      method: "DELETE",
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function purgeCustomerMemory(
  accessToken: string,
  contact: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/memory?contact=" + encodeURIComponent(contact),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getJourney(
  accessToken: string,
  contact: string
): Promise<JourneySnapshot | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/journey?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as JourneySnapshot | null;
}

export async function moveJourneyStage(
  accessToken: string,
  contact: string,
  stageId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/journey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, stage_id: stageId }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function addJourneyStage(
  accessToken: string,
  name: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/journey/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteJourneyStage(
  accessToken: string,
  stageId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/journey/stages/" + stageId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getExplain(
  accessToken: string,
  contact: string
): Promise<{ activity: ExplainActivity[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/explain?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    activity: ExplainActivity[];
  } | null;
}

export interface RecoveryItem {
  id: number;
  kind: string;
  contact_id: string;
  conversation_id: number | null;
  priority: number;
  status: string;
  note: string;
  created_at: string | null;
}

export interface RecoverySettings {
  auto_enabled: boolean;
  checkout_hours: number;
  cod_hours: number;
  inactive_days: number;
  min_value: number;
}

export interface PriceBounds {
  enabled: boolean;
  min_price: number;
  max_discount_pct: number;
}

export interface NegotiationDecision {
  decision: "accept" | "counter" | "reject";
  counter_price: number;
  floor: number;
  message: string;
}

export async function listRecoveries(
  accessToken: string
): Promise<{ items: RecoveryItem[]; settings: RecoverySettings } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    items: RecoveryItem[];
    settings: RecoverySettings;
  } | null;
}

export async function sendRecoveryFollowup(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery/followup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function dismissRecovery(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function putRecoverySettings(
  accessToken: string,
  settings: RecoverySettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getPriceBounds(
  accessToken: string
): Promise<PriceBounds | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/bounds"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    settings?: PriceBounds;
  } | null;
  return payload?.settings ?? null;
}

export async function putPriceBounds(
  accessToken: string,
  settings: PriceBounds
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/bounds",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function decideNegotiation(
  accessToken: string,
  input: { price: number; offer: number; conversation_id?: number }
): Promise<NegotiationDecision | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/negotiation/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as NegotiationDecision | null;
}

export async function generateBroadcastCopy(
  accessToken: string,
  topic: string,
  lang: "ur" | "roman" | "en"
): Promise<{ variants: string[]; source: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/copygen/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, lang }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    variants: string[];
    source: string;
  } | null;
}

export interface RiskFactor {
  key: string;
  points: number;
  note: string;
}

export interface RiskScore {
  score: number;
  factors: RiskFactor[];
  recommendation: "proceed" | "collect_advance" | "hold";
  threshold: number;
  task_created: boolean;
}

export interface RiskSettings {
  score_threshold: number;
  staff_tasks: boolean;
  city_default_pct: number;
}

export interface RiskTask {
  id: number;
  contact_id: string;
  conversation_id: number | null;
  score: number;
  factors: RiskFactor[];
  created_at: string | null;
}

export interface AddressIntel {
  normalized: string;
  city: string | null;
  phone: string | null;
  issues: string[];
  ask_prompts: string[];
}

export async function getRiskScore(
  accessToken: string,
  contact: string,
  options?: { total?: number; address?: string }
): Promise<RiskScore | null> {
  let query = "?contact=" + encodeURIComponent(contact);
  if (options?.total) query += "&total=" + encodeURIComponent(String(options.total));
  if (options?.address)
    query += "&address=" + encodeURIComponent(options.address);
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/score" + query);
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as RiskScore | null;
}

export async function getRiskSettings(
  accessToken: string
): Promise<{ settings: RiskSettings; city_rates: { city: string; return_pct: number }[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    settings: RiskSettings;
    city_rates: { city: string; return_pct: number }[];
  } | null;
}

export async function putRiskSettings(
  accessToken: string,
  settings: RiskSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function listRiskTasks(
  accessToken: string
): Promise<{ tasks: RiskTask[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/tasks");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    tasks: RiskTask[];
  } | null;
}

export async function completeRiskTask(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function normalizeAddress(
  accessToken: string,
  address: string
): Promise<AddressIntel | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/address/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AddressIntel | null;
}

export interface CourierSettings {
  configured: boolean;
  enabled: boolean;
  provider: string;
  base_url: string;
  api_key_masked: string;
  api_password_masked: string;
  secret_label: string;
  providers: { id: string; label: string; default_base: string }[];
}

export interface CourierBooking {
  id: number;
  contact_id: string;
  tracking_number: string;
  provider: string;
  status: string;
  raw_status: string;
  cod_amount: number;
  city: string;
  created_at: string | null;
  tracked_at: string | null;
}

export interface CourierBookInput {
  contact_id?: string;
  customer_name?: string;
  phone?: string;
  city: string;
  address: string;
  cod_amount?: number;
  pieces?: number;
  weight?: number;
  description?: string;
}

export async function getCourierSettings(
  accessToken: string
): Promise<CourierSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as CourierSettings | null;
}

export async function putCourierSettings(
  accessToken: string,
  settings: {
    provider: string;
    api_key?: string;
    api_password?: string;
    base_url?: string;
    enabled?: boolean;
  }
): Promise<{ ok: boolean; configured: boolean } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    configured: boolean;
  } | null;
}

export async function testCourierConnection(
  accessToken: string
): Promise<{ ok: boolean; message: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    message?: string;
  } | null;
  if (payload === null) return null;
  return { ok: Boolean(payload.ok), message: payload.message ?? "" };
}

export async function bookCourierParcel(
  accessToken: string,
  input: CourierBookInput
): Promise<{
  ok: boolean;
  id: number | null;
  tracking_number: string;
  address_issues: string[];
  ask_prompts: string[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number | null;
    tracking_number: string;
    address_issues: string[];
    ask_prompts: string[];
  } | null;
}

export async function listCourierBookings(
  accessToken: string
): Promise<{
  bookings: CourierBooking[];
  summary: Record<string, number>;
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/bookings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    bookings: CourierBooking[];
    summary: Record<string, number>;
  } | null;
}

export async function trackCourierParcel(
  accessToken: string,
  id: number
): Promise<{
  ok: boolean;
  id: number;
  status: string;
  raw_status: string;
  events: { when: string; status: string; detail: string }[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number;
    status: string;
    raw_status: string;
    events: { when: string; status: string; detail: string }[];
  } | null;
}

export interface CourierProvider {
  id: number;
  name: string;
  adapter: string;
  base_url: string;
  api_key_masked: string;
  api_secret_masked: string;
  booking_mode: string;
  enabled: boolean;
  test_status: string;
  test_message: string;
  created_at: string;
}

export interface CourierProviderAdapter {
  key: string;
  label: string;
  default_base: string;
  secret_label: string;
}

export interface CourierProviderInput {
  name: string;
  adapter: string;
  base_url?: string;
  api_key?: string;
  api_secret?: string;
  booking_mode?: string;
  enabled?: boolean;
}

export async function listCourierProviders(
  accessToken: string
): Promise<{
  providers: CourierProvider[];
  adapters: CourierProviderAdapter[];
  booking_modes: string[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/providers");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    providers: CourierProvider[];
    adapters: CourierProviderAdapter[];
    booking_modes: string[];
  } | null;
}

export async function createCourierProvider(
  accessToken: string,
  input: CourierProviderInput
): Promise<{ ok: boolean; id: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number;
  } | null;
}

export async function updateCourierProvider(
  accessToken: string,
  id: number,
  patch: Partial<CourierProviderInput>
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/providers/" + id,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCourierProvider(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/providers/" + id,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function testCourierProvider(
  accessToken: string,
  id: number
): Promise<{ ok: boolean; message: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/providers/" + id + "/test",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    message: string;
  } | null;
}

export async function confirmCourierBooking(
  accessToken: string,
  id: number
): Promise<{ ok: boolean; id: number; tracking_number: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/bookings/" + id + "/confirm",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number;
    tracking_number: string;
  } | null;
}

export interface OperationsSnapshot {
  chats: { new: number; open: number; total: number };
  messages: { received: number; sent: number };
  orders: { paid: number; revenue: number };
  deliveries: {
    bookings: number;
    by_status: Record<string, number>;
  };
  recovery: { open: number; resolved: number };
  csat: { answers: number; avg_score: number | null };
}

export async function getOperations(
  accessToken: string,
  days?: number
): Promise<{ days: number; operations: OperationsSnapshot } | null> {
  let response: Response;
  try {
    const query = days ? "?days=" + String(days) : "";
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/operations" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    days: number;
    operations: OperationsSnapshot;
  } | null;
}

export interface TemplatePack {
  key: string;
  label: string;
  description: string;
  persona: {
    agent_name: string;
    tone: string;
    greeting: string;
    fallback: string;
  };
  kb: { title: string; category: string; keywords: string;
        content: string; lang: string }[];
  keywords: { keyword: string; note: string }[];
  saved_replies: { shortcut: string; body: string }[];
  journey: string[];
  /** Workflow drafts seeded on activation (V2 B15 + Workflow Builder batch). */
  workflows?: { key: string; name: string; description: string;
                trigger_type: string }[];
}

export interface TemplatesPayload {
  packs: TemplatePack[];
  applied: string;
  applied_at: string;
}

export async function listTemplates(
  accessToken: string
): Promise<TemplatesPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as TemplatesPayload | null;
}

export async function applyTemplate(
  accessToken: string,
  vertical: string,
  overwritePersona = false
): Promise<{
  ok: boolean;
  vertical: string;
  created: Record<string, number>;
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vertical, overwrite_persona: overwritePersona }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    vertical: string;
    created: Record<string, number>;
  } | null;
}

export interface Brand {
  id: number;
  name: string;
  slug: string | null;
  isActive: boolean;
  createdAt: string | null;
}

function mapBrand(raw: Record<string, unknown>): Brand {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    slug: typeof raw.slug === "string" && raw.slug ? raw.slug : null,
    isActive: raw.is_active === true,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
  };
}

export interface VoiceCall {
  id: number;
  contactId: string;
  phone: string;
  sid: string;
  status: string;
  message: string;
  direction: "inbound" | "outbound";
  hasRecording: boolean;
  durationSeconds: number;
  /** D5: assistant turns spoken on this call (0 = voicemail only). */
  aiTurns: number;
  /** D5: ai | handoff | turn_limit | no_speech | voicemail | transfer_missed | "" */
  outcome: string;
  createdAt: string | null;
}

export function voiceRecordingPath(sid: string): string {
  return "/api/omniflow/portal/voice/recordings/" + sid;
}

export async function listVoiceCalls(
  accessToken: string
): Promise<VoiceCall[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/voice/calls", {
      method: "GET",
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).calls
    : null;
  if (!Array.isArray(raw)) return null;
  return raw.map((row: Record<string, unknown>) => ({
    id: Number(row.id || 0),
    contactId: String(row.contact_id || ""),
    phone: String(row.phone || ""),
    sid: String(row.sid || ""),
    status: String(row.status || ""),
    message: String(row.message || ""),
    direction: row.direction === "inbound" ? "inbound" as const : "outbound" as const,
    hasRecording: row.has_recording === true,
    durationSeconds: Number(row.duration_seconds || 0),
    aiTurns: Number(row.ai_turns || 0),
    outcome: String(row.outcome || ""),
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  }));
}

export type VoiceCallMutation =
  | { ok: true; call: VoiceCall }
  | "not_configured"
  | "bad_request"
  | null;

export async function callContact(
  accessToken: string,
  contactId: string,
  phone: string,
  message: string
): Promise<VoiceCallMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/voice/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, phone, message }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) return "not_configured";
  if (response.status === 400) return "bad_request";
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).call;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    ok: true,
    call: {
      id: Number(row.id || 0),
      contactId: String(row.contact_id || ""),
      phone: String(row.phone || ""),
      sid: String(row.sid || ""),
      status: String(row.status || ""),
      message: String(row.message || ""),
      direction: row.direction === "inbound" ? "inbound" as const : "outbound" as const,
      hasRecording: row.has_recording === true,
      durationSeconds: Number(row.duration_seconds || 0),
      aiTurns: Number(row.ai_turns || 0),
      outcome: String(row.outcome || ""),
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    },
  };
}

export async function fetchVoiceRecording(
  accessToken: string,
  sid: string
): Promise<Response> {
  return portalRequest(
    accessToken,
    "api/v1/portal/voice/recordings/" + sid,
    { method: "GET" }
  );
}

export interface VideoRoom {
  id: number;
  conversationId: number;
  contactId: string;
  provider: string;
  url: string;
  createdAt: string | null;
}

export async function listVideoRooms(
  accessToken: string,
  conversationId?: number
): Promise<VideoRoom[] | null> {
  let response: Response;
  try {
    const query = conversationId && conversationId > 0
      ? "?conversation_id=" + conversationId
      : "";
    response = await portalRequest(
      accessToken,
      "api/v1/portal/video/rooms" + query,
      { method: "GET" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rooms
    : null;
  if (!Array.isArray(raw)) return null;
  return raw.map((row: Record<string, unknown>) => ({
    id: Number(row.id || 0),
    conversationId: Number(row.conversation_id || 0),
    contactId: String(row.contact_id || ""),
    provider: String(row.provider || ""),
    url: String(row.url || ""),
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  }));
}

export type VideoRoomMutation =
  | { ok: true; room: VideoRoom }
  | "not_configured"
  | "bad_request"
  | null;

export async function sendVideoInvite(
  accessToken: string,
  conversationId: number,
  provider?: string,
  title?: string
): Promise<VideoRoomMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/video/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        provider: provider || undefined,
        title: title || undefined,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) return "not_configured";
  if (response.status === 400) return "bad_request";
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).room;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    ok: true,
    room: {
      id: Number(row.id || 0),
      conversationId: Number(row.conversation_id || 0),
      contactId: String(row.contact_id || ""),
      provider: String(row.provider || ""),
      url: String(row.url || ""),
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    },
  };
}

export async function listBrands(
  accessToken: string
): Promise<Brand[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brands");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).brands;
  if (!Array.isArray(rawList)) return null;
  return rawList
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map(mapBrand);
}

export async function createBrand(
  accessToken: string,
  name: string
): Promise<{ ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, status: 0 };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, status: response.status };
}

export async function updateBrand(
  accessToken: string,
  brandId: number,
  changes: { name?: string; isActive?: boolean }
): Promise<{ ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/brands/" + String(brandId),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.isActive !== undefined
            ? { is_active: changes.isActive }
            : {}),
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, status: 0 };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, status: response.status };
}

export async function deleteBrand(
  accessToken: string,
  brandId: number
): Promise<{ ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/brands/" + String(brandId),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, status: 0 };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, status: response.status };
}

export interface PlansPayload {
  plan: string;
  limits: Record<string, number | null>;
  usage: Record<string, number>;
  catalog: {
    key: string;
    label: string;
    description: string;
    limits: Record<string, number | null>;
  }[];
}

export async function getPlans(
  accessToken: string
): Promise<PlansPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/plans");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as PlansPayload | null;
}

export async function putPlan(
  accessToken: string,
  plan: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface MediaAsset {
  id: number;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  created_at: string | null;
}

export async function listMediaAssets(
  accessToken: string
): Promise<{ assets: MediaAsset[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    assets: MediaAsset[];
  } | null;
}

export async function uploadMediaAsset(
  accessToken: string,
  form: FormData
): Promise<{ asset: MediaAsset | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media", {
      method: "POST",
      body: form,
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    asset: MediaAsset | null;
  } | null;
}

export async function deleteMediaAsset(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function sendMediaAsset(
  accessToken: string,
  input: { id: number; contact_id: string; conversation_id?: number;
    caption?: string }
): Promise<{ ok: boolean; queued: boolean } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    queued: boolean;
  } | null;
}

export async function transcribeMediaAsset(
  accessToken: string,
  id: number
): Promise<{ ok: boolean; text: string; model: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/media/transcribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    text: string;
    model: string;
  } | null;
}

export interface PerfReport {
  counts: {
    conversations: number;
    messages: number;
    actions: number;
    checkout_links: number;
  };
  timings_ms: {
    recent_conversations: number;
    recent_messages: number;
    open_links: number;
  };
  indexes: string[];
  hot_indexes_present: string[];
  missing_hot_indexes: string[];
  ok: boolean;
}

export async function getPerfReport(
  accessToken: string
): Promise<PerfReport | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/perf");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as PerfReport | null;
}

export async function replayDelivery(
  accessToken: string,
  deliveryId: number
): Promise<{ ok: true } | "bad_request" | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/deliveries/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deliveryId }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return "bad_request";
  if (response.status === 404) return "not_found";
  if (!response.ok) return null;
  return { ok: true };
}

export type CheckoutShareMutation =
  | { ok: true }
  | "not_found"
  | "bad_request"
  | null;

export async function shareCheckoutLink(
  accessToken: string,
  linkId: number,
  message: string
): Promise<CheckoutShareMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/share",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true };
}

export async function setLinkTracking(
  accessToken: string,
  linkId: number,
  courier: string,
  trackingNumber: string
): Promise<{ ok: true } | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/tracking",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courier,
          tracking_number: trackingNumber,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true };
}

export type CheckoutAdvanceMutation =
  | { ok: true; paidAmount: number; due: number; status: string }
  | "not_found"
  | "bad_request"
  | "forbidden"
  | null;

export async function addCheckoutAdvance(
  accessToken: string,
  linkId: number,
  amount: number
): Promise<CheckoutAdvanceMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/advance",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 403) return "forbidden";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return {
    ok: true,
    paidAmount: typeof row.paid_amount === "number" ? row.paid_amount : 0,
    due: typeof row.due === "number" ? row.due : 0,
    status: typeof row.status === "string" ? row.status : "open",
  };
}

export interface ListenRule {
  id: number;
  keyword: string;
  note: string;
}

export async function listListenRules(
  accessToken: string
): Promise<ListenRule[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/listen/rules");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rules
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      keyword: typeof item.keyword === "string" ? item.keyword : "",
      note: typeof item.note === "string" ? item.note : "",
    }));
}

export async function addListenRule(
  accessToken: string,
  keyword: string,
  note: string
): Promise<ListenRule | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/listen/rules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, note }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rule
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    id: typeof row.id === "number" ? row.id : 0,
    keyword: typeof row.keyword === "string" ? row.keyword : keyword,
    note: typeof row.note === "string" ? row.note : note,
  };
}

export type ListenRuleRemoval = { ok: true } | "not_found" | null;

export async function deleteListenRule(
  accessToken: string,
  ruleId: number
): Promise<ListenRuleRemoval> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/listen/rules/" + ruleId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface ListenHit {
  id: number;
  keyword: string;
  conversationId: number | null;
  contactId: string;
  snippet: string;
  createdAt: string | null;
}

export async function listListenHits(
  accessToken: string
): Promise<ListenHit[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/listen/hits");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).hits
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      keyword: typeof item.keyword === "string" ? item.keyword : "",
      conversationId:
        typeof item.conversation_id === "number" ? item.conversation_id : null,
      contactId: typeof item.contact_id === "string" ? item.contact_id : "",
      snippet: typeof item.snippet === "string" ? item.snippet : "",
      createdAt: typeof item.created_at === "string" ? item.created_at : null,
    }));
}

export type RoutingTargetType = "user" | "agent";

export interface RoutingRule {
  id: number;
  match: string;
  userId: number;
  priority: number;
  targetType: RoutingTargetType;
  agentId: number | null;
  agentName: string | null;
}

export async function listRoutingRules(
  accessToken: string
): Promise<RoutingRule[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/routing/rules");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rules
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      match: typeof item.match === "string" ? item.match : "",
      userId: typeof item.user_id === "number" ? item.user_id : 0,
      priority: typeof item.priority === "number" ? item.priority : 100,
      targetType:
        item.target_type === "agent" ? "agent" : "user",
      agentId: typeof item.agent_id === "number" ? item.agent_id : null,
      agentName:
        typeof item.agent_name === "string" ? item.agent_name : null,
    }));
}

export async function addRoutingRule(
  accessToken: string,
  match: string,
  userId: number,
  priority: number,
  targetType: RoutingTargetType = "user",
  agentId: number | null = null
): Promise<RoutingRule | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/routing/rules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match,
          user_id: userId,
          priority,
          target_type: targetType,
          agent_id: targetType === "agent" ? agentId : null,
        }),
      }
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
  const row = payload as Record<string, unknown>;
  return {
    id: typeof row.id === "number" ? row.id : 0,
    match,
    userId,
    priority,
    targetType,
    agentId: targetType === "agent" ? agentId : null,
    agentName: null,
  };
}

export type RoutingRuleRemoval = { ok: true } | "not_found" | null;

export async function deleteRoutingRule(
  accessToken: string,
  ruleId: number
): Promise<RoutingRuleRemoval> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/routing/rules/" + ruleId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export type AgentRisk = "low" | "medium" | "high";

export interface AgentScheduleDay {
  enabled: boolean;
  start: string;
  end: string;
}

export interface AgentSchedule {
  enabled: boolean;
  timezone: string;
  days: AgentScheduleDay[];
}

export interface PortalAgent {
  id: number;
  name: string;
  tone: string;
  instructions: string;
  escalationUserId: number | null;
  isActive: boolean;
  versions: number;
  /** Registry action names the persona may trigger; null = every action. */
  allowedActions: string[] | null;
  /** Highest action risk the persona may trigger (HIGH still needs approval). */
  maxRisk: AgentRisk;
  /** false = drafts only: the brain never auto-sends under this persona. */
  canAutoReply: boolean;
  /** Weekly auto-reply windows; enabled false = always on. */
  schedule: AgentSchedule;
  /** Live clock: whether the agent is inside its schedule right now. */
  inHours: boolean;
}

function normalizeRisk(value: unknown): AgentRisk {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "high";
}

function normalizeAllowedActions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item): item is string => typeof item === "string" && item !== "")
    .slice(0, 100);
}

function normalizeAgent(item: unknown): PortalAgent | null {
  if (item === null || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : 0;
  if (id <= 0) return null;
  return {
    id,
    name: typeof row.name === "string" ? row.name : "",
    tone: typeof row.tone === "string" ? row.tone : "",
    instructions:
      typeof row.instructions === "string" ? row.instructions : "",
    escalationUserId:
      typeof row.escalation_user_id === "number"
        ? row.escalation_user_id
        : null,
    isActive: row.is_active !== false,
    versions: typeof row.versions === "number" ? row.versions : 0,
    allowedActions: normalizeAllowedActions(row.allowed_actions),
    maxRisk: normalizeRisk(row.max_risk),
    canAutoReply: row.can_auto_reply !== false,
    schedule: normalizeAgentSchedule(row.schedule),
    inHours: row.in_hours !== false,
  };
}

export async function listAgents(
  accessToken: string
): Promise<PortalAgent[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/agents");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).agents
      : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeAgent)
    .filter((agent): agent is PortalAgent => agent !== null);
}

export interface AgentUpsert {
  name: string;
  tone: string;
  instructions: string;
  escalationUserId: number | null;
  /** Permission envelope (omitted = every action / high / auto-reply on). */
  allowedActions?: string[] | null;
  maxRisk?: AgentRisk;
  canAutoReply?: boolean;
  schedule?: AgentSchedule;
}

function defaultAgentSchedule(): AgentSchedule {
  return {
    enabled: false,
    timezone: "Asia/Karachi",
    days: Array.from({ length: 7 }, () => ({
      enabled: true,
      start: "09:00",
      end: "17:00",
    })),
  };
}

function normalizeAgentSchedule(raw: unknown): AgentSchedule {
  const fallback = defaultAgentSchedule();
  if (raw === null || typeof raw !== "object") return fallback;
  const row = raw as Record<string, unknown>;
  const daysRaw = Array.isArray(row.days) ? row.days : [];
  const days = fallback.days.map((day, index) => {
    const item =
      daysRaw[index] !== null && typeof daysRaw[index] === "object"
        ? (daysRaw[index] as Record<string, unknown>)
        : null;
    if (!item) return day;
    return {
      enabled: item.enabled !== false,
      start: typeof item.start === "string" ? item.start : day.start,
      end: typeof item.end === "string" ? item.end : day.end,
    };
  });
  return {
    enabled: row.enabled === true,
    timezone:
      typeof row.timezone === "string" && row.timezone.trim()
        ? row.timezone.trim().slice(0, 64)
        : fallback.timezone,
    days,
  };
}

function agentBody(input: AgentUpsert): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name,
    tone: input.tone,
    instructions: input.instructions,
    escalation_user_id: input.escalationUserId,
  };
  if (input.allowedActions !== undefined) {
    body.allowed_actions = input.allowedActions;
  }
  if (input.maxRisk !== undefined) body.max_risk = input.maxRisk;
  if (input.canAutoReply !== undefined) {
    body.can_auto_reply = input.canAutoReply;
  }
  if (input.schedule !== undefined) {
    body.schedule = input.schedule;
  }
  return body;
}

export async function createAgent(
  accessToken: string,
  input: AgentUpsert
): Promise<PortalAgent | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentBody(input)),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).agent;
  return normalizeAgent(row);
}

export type AgentMutation =
  | { kind: "ok" }
  | { kind: "not_found" }
  | null;

export async function updateAgent(
  accessToken: string,
  agentId: number,
  input: AgentUpsert & { isActive: boolean }
): Promise<AgentMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/agents/" + agentId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...agentBody(input),
          is_active: input.isActive,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { kind: "ok" };
}

export async function archiveAgent(
  accessToken: string,
  agentId: number
): Promise<AgentMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/agents/" + agentId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { kind: "ok" };
}

// ---- agent versioning + rollback (history is never rewritten) ----

export interface PortalAgentVersion {
  version: number;
  note: string;
  createdAt: string;
  snapshot: {
    name: string;
    tone: string;
    instructions: string;
    escalationUserId: number | null;
    isActive: boolean;
    allowedActions: string[] | null;
    maxRisk: AgentRisk;
    canAutoReply: boolean;
    restoredFrom: number | null;
  };
}

function normalizeAgentVersion(item: unknown): PortalAgentVersion | null {
  if (item === null || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const version = typeof row.version === "number" ? row.version : 0;
  if (version <= 0) return null;
  const snap =
    row.snapshot !== null && typeof row.snapshot === "object"
      ? (row.snapshot as Record<string, unknown>)
      : {};
  return {
    version,
    note: typeof row.note === "string" ? row.note : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    snapshot: {
      name: typeof snap.name === "string" ? snap.name : "",
      tone: typeof snap.tone === "string" ? snap.tone : "",
      instructions:
        typeof snap.instructions === "string" ? snap.instructions : "",
      escalationUserId:
        typeof snap.escalation_user_id === "number"
          ? snap.escalation_user_id
          : null,
      isActive: snap.is_active !== false,
      allowedActions: normalizeAllowedActions(snap.allowed_actions),
      maxRisk: normalizeRisk(snap.max_risk),
      canAutoReply: snap.can_auto_reply !== false,
      restoredFrom:
        typeof snap.restored_from === "number" ? snap.restored_from : null,
    },
  };
}

export type AgentVersionsResult =
  | { kind: "ok"; versions: PortalAgentVersion[] }
  | { kind: "not_found" }
  | null;

export async function listAgentVersions(
  accessToken: string,
  agentId: number
): Promise<AgentVersionsResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/agents/" + agentId + "/versions"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).versions
      : null;
  const versions = Array.isArray(raw)
    ? raw
        .map(normalizeAgentVersion)
        .filter((item): item is PortalAgentVersion => item !== null)
    : [];
  return { kind: "ok", versions };
}

export type AgentRollbackResult =
  | { kind: "ok"; version: number; restoredFrom: number }
  | { kind: "not_found" }
  | null;

export async function rollbackAgent(
  accessToken: string,
  agentId: number,
  version: number
): Promise<AgentRollbackResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/agents/" + agentId + "/rollback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    version?: unknown;
    restored_from?: unknown;
  } | null;
  return {
    kind: "ok",
    version: typeof payload?.version === "number" ? payload.version : 0,
    restoredFrom:
      typeof payload?.restored_from === "number" ? payload.restored_from : version,
  };
}

// ---------------------------------------------------------------------------
// Workflows (engine 9): trigger -> steps automations + runs
// ---------------------------------------------------------------------------

export type WorkflowStepKind =
  | "condition"
  | "branch"
  | "ai_decision"
  | "action"
  | "wait"
  | "approval"
  | "handoff"
  | "goal"
  | "stop";

export interface WorkflowStep {
  stepNo: number;
  kind: WorkflowStepKind;
  label: string;
  config: Record<string, unknown>;
}

export interface WorkflowRunStats {
  total: number;
  live: number;
  goals: number;
  failed: number;
  lastRunAt: string | null;
}

export interface PortalWorkflow {
  id: number;
  name: string;
  description: string;
  status: "draft" | "active" | "paused" | "archived";
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  stopOnReply: boolean;
  version: number;
  stepCount: number;
  steps: WorkflowStep[];
  runs: WorkflowRunStats;
  updatedAt: string | null;
}

export interface WorkflowRunLogLine {
  stepNo: number;
  kind: string;
  outcome: string;
  detail: string;
  at: string | null;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  event: string;
  conversationId: number | null;
  contactId: string;
  contactName: string;
  status: string;
  currentStep: number;
  stepsDone: number;
  goal: string | null;
  lastError: string | null;
  resumeAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  log: WorkflowRunLogLine[];
}

export interface WorkflowTriggerSpec {
  trigger: string;
  label: string;
  source: string;
  options: string[];
  description: string;
}

export interface WorkflowActionSpec {
  action: string;
  description: string;
  risk: "low" | "medium" | "high";
  required: string[];
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  /** Industry pack key ("general" when the template fits every business). */
  vertical: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  stopOnReply: boolean;
  steps: { kind: WorkflowStepKind; label: string; config: Record<string, unknown> }[];
}

export interface WorkflowCatalog {
  triggers: WorkflowTriggerSpec[];
  actions: WorkflowActionSpec[];
  stepKinds: WorkflowStepKind[];
  templates: WorkflowTemplate[];
  /** Template groups in catalog order (general first, then industry packs). */
  verticals: { key: string; label: string }[];
  /** Industry pack the workspace activated in Setup ("" when none). */
  appliedVertical: string;
  limits: { maxWorkflows: number; maxSteps: number; maxWaitMinutes: number };
}

export interface WorkflowUpsert {
  name: string;
  description: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  stopOnReply: boolean;
  steps: { kind: string; label: string; config: Record<string, unknown> }[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeWorkflowStep(item: unknown): WorkflowStep | null {
  const row = asRecord(item);
  const kind = typeof row.kind === "string" ? row.kind : "";
  if (!kind) return null;
  return {
    stepNo: typeof row.step_no === "number" ? row.step_no : 0,
    kind: kind as WorkflowStepKind,
    label: typeof row.label === "string" ? row.label : "",
    config: asRecord(row.config),
  };
}

function normalizeWorkflow(item: unknown): PortalWorkflow | null {
  const row = asRecord(item);
  const id = typeof row.id === "number" ? row.id : 0;
  if (id <= 0) return null;
  const runs = asRecord(row.runs);
  const status = typeof row.status === "string" ? row.status : "draft";
  const steps = Array.isArray(row.steps)
    ? row.steps
        .map(normalizeWorkflowStep)
        .filter((step): step is WorkflowStep => step !== null)
    : [];
  return {
    id,
    name: typeof row.name === "string" ? row.name : "",
    description: typeof row.description === "string" ? row.description : "",
    status: (["draft", "active", "paused", "archived"].includes(status)
      ? status
      : "draft") as PortalWorkflow["status"],
    triggerType:
      typeof row.trigger_type === "string" ? row.trigger_type : "manual",
    triggerConfig: asRecord(row.trigger_config),
    stopOnReply: row.stop_on_reply === true,
    version: typeof row.version === "number" ? row.version : 1,
    stepCount:
      typeof row.steps === "number" ? row.steps : steps.length,
    steps,
    runs: {
      total: typeof runs.total === "number" ? runs.total : 0,
      live: typeof runs.live === "number" ? runs.live : 0,
      goals: typeof runs.goals === "number" ? runs.goals : 0,
      failed: typeof runs.failed === "number" ? runs.failed : 0,
      lastRunAt:
        typeof runs.last_run_at === "string" ? runs.last_run_at : null,
    },
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function normalizeWorkflowRun(item: unknown): WorkflowRun | null {
  const row = asRecord(item);
  const id = typeof row.id === "number" ? row.id : 0;
  if (id <= 0) return null;
  const log = Array.isArray(row.log)
    ? row.log.map((line) => {
        const entry = asRecord(line);
        return {
          stepNo: typeof entry.step_no === "number" ? entry.step_no : 0,
          kind: typeof entry.kind === "string" ? entry.kind : "",
          outcome: typeof entry.outcome === "string" ? entry.outcome : "",
          detail: typeof entry.detail === "string" ? entry.detail : "",
          at: typeof entry.at === "string" ? entry.at : null,
        };
      })
    : [];
  return {
    id,
    workflowId: typeof row.workflow_id === "number" ? row.workflow_id : 0,
    event: typeof row.event === "string" ? row.event : "",
    conversationId:
      typeof row.conversation_id === "number" ? row.conversation_id : null,
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    contactName: typeof row.contact_name === "string" ? row.contact_name : "",
    status: typeof row.status === "string" ? row.status : "",
    currentStep: typeof row.current_step === "number" ? row.current_step : 0,
    stepsDone: typeof row.steps_done === "number" ? row.steps_done : 0,
    goal: typeof row.goal === "string" ? row.goal : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    resumeAt: typeof row.resume_at === "string" ? row.resume_at : null,
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    log,
  };
}

function workflowBody(input: WorkflowUpsert): string {
  return JSON.stringify({
    name: input.name,
    description: input.description,
    trigger_type: input.triggerType,
    trigger_config: input.triggerConfig,
    stop_on_reply: input.stopOnReply,
    steps: input.steps.map((step) => ({
      kind: step.kind,
      label: step.label,
      config: step.config,
    })),
  });
}

/** A starter template - or a generated draft (§231), which has the same shape. */
function normalizeWorkflowTemplate(item: unknown): WorkflowTemplate {
  const row = asRecord(item);
  return {
    key: typeof row.key === "string" ? row.key : "",
    name: typeof row.name === "string" ? row.name : "",
    description:
      typeof row.description === "string" ? row.description : "",
    vertical:
      typeof row.vertical === "string" && row.vertical
        ? row.vertical
        : "general",
    triggerType:
      typeof row.trigger_type === "string" ? row.trigger_type : "manual",
    triggerConfig: asRecord(row.trigger_config),
    stopOnReply: row.stop_on_reply === true,
    steps: Array.isArray(row.steps)
      ? row.steps.map((step) => {
          const s = asRecord(step);
          return {
            kind: (typeof s.kind === "string"
              ? s.kind
              : "stop") as WorkflowStepKind,
            label: typeof s.label === "string" ? s.label : "",
            config: asRecord(s.config),
          };
        })
      : [],
  };
}

export async function getWorkflowCatalog(
  accessToken: string
): Promise<WorkflowCatalog | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/workflows/catalog");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const limits = asRecord(payload.limits);
  const triggers = Array.isArray(payload.triggers) ? payload.triggers : [];
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const templates = Array.isArray(payload.templates) ? payload.templates : [];
  return {
    triggers: triggers.map((item) => {
      const row = asRecord(item);
      return {
        trigger: typeof row.trigger === "string" ? row.trigger : "",
        label: typeof row.label === "string" ? row.label : "",
        source: typeof row.source === "string" ? row.source : "",
        options: Array.isArray(row.options)
          ? row.options.filter((o): o is string => typeof o === "string")
          : [],
        description:
          typeof row.description === "string" ? row.description : "",
      };
    }),
    actions: actions.map((item) => {
      const row = asRecord(item);
      const risk = typeof row.risk === "string" ? row.risk : "medium";
      return {
        action: typeof row.action === "string" ? row.action : "",
        description:
          typeof row.description === "string" ? row.description : "",
        risk: (["low", "medium", "high"].includes(risk)
          ? risk
          : "medium") as WorkflowActionSpec["risk"],
        required: Array.isArray(row.required)
          ? row.required.filter((r): r is string => typeof r === "string")
          : [],
      };
    }),
    stepKinds: Array.isArray(payload.step_kinds)
      ? (payload.step_kinds.filter(
          (k): k is string => typeof k === "string"
        ) as WorkflowStepKind[])
      : [],
    templates: templates.map(normalizeWorkflowTemplate),
    verticals: (Array.isArray(payload.verticals) ? payload.verticals : [])
      .map((item) => {
        const row = asRecord(item);
        return {
          key: typeof row.key === "string" ? row.key : "",
          label: typeof row.label === "string" ? row.label : "",
        };
      })
      .filter((v) => v.key !== ""),
    appliedVertical:
      typeof payload.applied_vertical === "string"
        ? payload.applied_vertical
        : "",
    limits: {
      maxWorkflows:
        typeof limits.max_workflows === "number" ? limits.max_workflows : 20,
      maxSteps: typeof limits.max_steps === "number" ? limits.max_steps : 12,
      maxWaitMinutes:
        typeof limits.max_wait_minutes === "number"
          ? limits.max_wait_minutes
          : 10080,
    },
  };
}

export async function listWorkflows(
  accessToken: string
): Promise<PortalWorkflow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/workflows");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  if (!Array.isArray(payload.workflows)) return [];
  return payload.workflows
    .map(normalizeWorkflow)
    .filter((item): item is PortalWorkflow => item !== null);
}

export async function getWorkflow(
  accessToken: string,
  workflowId: number
): Promise<PortalWorkflow | null | "not_found"> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return normalizeWorkflow(payload.workflow);
}

export type WorkflowWriteResult =
  | { kind: "ok"; workflow?: PortalWorkflow | null; version?: number }
  | { kind: "not_found" }
  | { kind: "bad_request"; message: string }
  | null;

async function readWriteError(response: Response): Promise<WorkflowWriteResult> {
  const payload = asRecord(await response.json().catch(() => null));
  const error = asRecord(payload.error);
  return {
    kind: "bad_request",
    message:
      typeof error.message === "string" ? error.message : "Check the workflow.",
  };
}

export async function createWorkflow(
  accessToken: string,
  input: WorkflowUpsert
): Promise<WorkflowWriteResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: workflowBody(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return readWriteError(response);
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return { kind: "ok", workflow: normalizeWorkflow(payload.workflow) };
}

export async function updateWorkflow(
  accessToken: string,
  workflowId: number,
  input: WorkflowUpsert
): Promise<WorkflowWriteResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: workflowBody(input),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return readWriteError(response);
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return {
    kind: "ok",
    version: typeof payload.version === "number" ? payload.version : undefined,
  };
}

export async function setWorkflowStatus(
  accessToken: string,
  workflowId: number,
  status: "active" | "paused"
): Promise<WorkflowWriteResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId + "/status",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return readWriteError(response);
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { kind: "ok" };
}

export async function archiveWorkflow(
  accessToken: string,
  workflowId: number
): Promise<WorkflowWriteResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { kind: "ok" };
}

export async function listWorkflowRuns(
  accessToken: string,
  workflowId: number,
  limit = 20
): Promise<WorkflowRun[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId + "/runs?limit=" +
        Math.max(1, Math.min(50, Math.round(limit)))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  if (!Array.isArray(payload.runs)) return [];
  return payload.runs
    .map(normalizeWorkflowRun)
    .filter((run): run is WorkflowRun => run !== null);
}

export interface PortalWorkflowVersion {
  version: number;
  createdAt: string;
  snapshot: {
    name: string;
    description: string;
    triggerType: string;
    triggerConfig: Record<string, unknown>;
    stopOnReply: boolean;
    steps: { kind: string; label: string; config: Record<string, unknown> }[];
    restoredFrom: number | null;
  };
}

function normalizeWorkflowVersion(item: unknown): PortalWorkflowVersion | null {
  const row = asRecord(item);
  const version = typeof row.version === "number" ? row.version : 0;
  if (version <= 0) return null;
  const snap = asRecord(row.snapshot);
  const stepsRaw = Array.isArray(snap.steps) ? snap.steps : [];
  return {
    version,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    snapshot: {
      name: typeof snap.name === "string" ? snap.name : "",
      description: typeof snap.description === "string" ? snap.description : "",
      triggerType:
        typeof snap.trigger_type === "string" ? snap.trigger_type : "manual",
      triggerConfig: asRecord(snap.trigger_config),
      stopOnReply: snap.stop_on_reply === true,
      steps: stepsRaw.map((step) => {
        const s = asRecord(step);
        return {
          kind: typeof s.kind === "string" ? s.kind : "",
          label: typeof s.label === "string" ? s.label : "",
          config: asRecord(s.config),
        };
      }),
      restoredFrom:
        typeof snap.restored_from === "number" ? snap.restored_from : null,
    },
  };
}

export type WorkflowVersionsResult =
  | { kind: "ok"; versions: PortalWorkflowVersion[] }
  | { kind: "not_found" }
  | null;

export async function listWorkflowVersions(
  accessToken: string,
  workflowId: number
): Promise<WorkflowVersionsResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId + "/versions"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const raw = Array.isArray(payload.versions) ? payload.versions : [];
  return {
    kind: "ok",
    versions: raw
      .map(normalizeWorkflowVersion)
      .filter((item): item is PortalWorkflowVersion => item !== null),
  };
}

export type WorkflowRollbackResult =
  | { kind: "ok"; version: number; restoredFrom: number }
  | { kind: "not_found" }
  | { kind: "bad_request"; message: string }
  | null;

export async function rollbackWorkflow(
  accessToken: string,
  workflowId: number,
  version: number
): Promise<WorkflowRollbackResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId + "/rollback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 400) {
    const payload = asRecord(await response.json().catch(() => null));
    const error = asRecord(payload.error);
    return {
      kind: "bad_request",
      message:
        typeof error.message === "string"
          ? error.message
          : "version must be a positive integer.",
    };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return {
    kind: "ok",
    version: typeof payload.version === "number" ? payload.version : 0,
    restoredFrom:
      typeof payload.restored_from === "number" ? payload.restored_from : version,
  };
}

export type WorkflowRunNowResult =
  | { kind: "ok"; runId: number; status: string }
  | { kind: "not_found" }
  | { kind: "bad_request"; message: string }
  | null;

export async function runWorkflowNow(
  accessToken: string,
  workflowId: number,
  conversationId: number
): Promise<WorkflowRunNowResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/workflows/" + workflowId + "/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400 || response.status === 409) {
    const payload = asRecord(await response.json().catch(() => null));
    const error = asRecord(payload.error);
    return {
      kind: "bad_request",
      message:
        typeof error.message === "string" ? error.message : "Run failed.",
    };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return {
    kind: "ok",
    runId: typeof payload.run_id === "number" ? payload.run_id : 0,
    status: typeof payload.status === "string" ? payload.status : "",
  };
}

export interface RecoSuggestion {
  name: string;
  priceText: string;
  notes: string;
  kind: string;
  score: number;
  reasons: string[];
}

export interface RecoSignals {
  paidItems: number;
  mentions: number;
  bestsellers: number;
  catalogItems: number;
}

export interface RecoResult {
  contactId: string;
  contactName: string | null;
  conversationId: number | null;
  suggestions: RecoSuggestion[];
  signals: RecoSignals;
}

export async function getRecoSuggestions(
  accessToken: string,
  contact: string
): Promise<RecoResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/reco/suggest?contact=" + encodeURIComponent(contact)
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
  const row = payload as Record<string, unknown>;
  const rawSuggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
  const signalsRaw =
    row.signals !== null && typeof row.signals === "object"
      ? (row.signals as Record<string, unknown>)
      : {};
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    contactName: null,
    conversationId: null,
    suggestions: rawSuggestions
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        priceText: typeof item.price_text === "string" ? item.price_text : "",
        notes: typeof item.notes === "string" ? item.notes : "",
        kind: typeof item.kind === "string" ? item.kind : "product",
        score: typeof item.score === "number" ? item.score : 0,
        reasons: Array.isArray(item.reasons)
          ? item.reasons.filter((r): r is string => typeof r === "string")
          : [],
      })),
    signals: {
      paidItems:
        typeof signalsRaw.paid_items === "number" ? signalsRaw.paid_items : 0,
      mentions:
        typeof signalsRaw.mentions === "number" ? signalsRaw.mentions : 0,
      bestsellers:
        typeof signalsRaw.bestsellers === "number" ? signalsRaw.bestsellers : 0,
      catalogItems:
        typeof signalsRaw.catalog_items === "number"
          ? signalsRaw.catalog_items
          : 0,
    },
  };
}

export async function getConversationRecos(
  accessToken: string,
  conversationId: number
): Promise<RecoResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/reco/surface?conversation_id=" + conversationId
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
  const row = payload as Record<string, unknown>;
  const rawSuggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    contactName:
      typeof row.contact_name === "string" ? row.contact_name : null,
    conversationId:
      typeof row.conversation_id === "number" ? row.conversation_id : null,
    suggestions: rawSuggestions
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        priceText: typeof item.price_text === "string" ? item.price_text : "",
        notes: typeof item.notes === "string" ? item.notes : "",
        kind: typeof item.kind === "string" ? item.kind : "product",
        score: typeof item.score === "number" ? item.score : 0,
        reasons: Array.isArray(item.reasons)
          ? item.reasons.filter((r): r is string => typeof r === "string")
          : [],
      })),
    signals: {
      paidItems: 0,
      mentions: 0,
      bestsellers: 0,
      catalogItems: 0,
    },
  };
}

export interface RecoBestseller {
  name: string;
  orders: number;
  priceText: string;
}

export interface RecoReport {
  bestsellers: RecoBestseller[];
  paidLinks: number;
  buyers: number;
  catalogItems: number;
}

export async function getRecoReport(
  accessToken: string
): Promise<RecoReport | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/reco/report");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawBest = Array.isArray(row.bestsellers) ? row.bestsellers : [];
  return {
    bestsellers: rawBest
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        orders: typeof item.orders === "number" ? item.orders : 0,
        priceText: typeof item.price_text === "string" ? item.price_text : "",
      })),
    paidLinks: typeof row.paid_links === "number" ? row.paid_links : 0,
    buyers: typeof row.buyers === "number" ? row.buyers : 0,
    catalogItems: typeof row.catalog_items === "number" ? row.catalog_items : 0,
  };
}

export interface ChurnSignals {
  lastInboundDays: number | null;
  unansweredDays: number | null;
  openCartDays: number | null;
  ordersLast30d: number;
  ordersPrior30d: number;
  paidOrders: number;
  lastOrderDays: number | null;
}

export interface ChurnScore {
  contactId: string;
  score: number;
  tier: string;
  reasons: string[];
  signals: ChurnSignals;
}

export interface ChurnRadarEntry {
  contactId: string;
  name: string;
  score: number;
  tier: string;
  reasons: string[];
}

export interface ChurnRadar {
  contacts: ChurnRadarEntry[];
  scored: number;
  counts: Record<string, number>;
}

export interface ChurnTopReason {
  reason: string;
  count: number;
}

export interface ChurnReport {
  scored: number;
  avgScore: number | null;
  tiers: Record<string, number>;
  topReasons: ChurnTopReason[];
}

function churnSignalsOf(row: Record<string, unknown>): ChurnSignals {
  const raw =
    row.signals !== null && typeof row.signals === "object"
      ? (row.signals as Record<string, unknown>)
      : {};
  const num = (key: string): number =>
    typeof raw[key] === "number" ? (raw[key] as number) : 0;
  const opt = (key: string): number | null =>
    typeof raw[key] === "number" ? (raw[key] as number) : null;
  return {
    lastInboundDays: opt("last_inbound_days"),
    unansweredDays: opt("unanswered_days"),
    openCartDays: opt("open_cart_days"),
    ordersLast30d: num("orders_last_30d"),
    ordersPrior30d: num("orders_prior_30d"),
    paidOrders: num("paid_orders"),
    lastOrderDays: opt("last_order_days"),
  };
}

function churnReasonsOf(row: Record<string, unknown>): string[] {
  const raw = row.reasons;
  return Array.isArray(raw)
    ? raw.filter((reason): reason is string => typeof reason === "string")
    : [];
}

export async function getChurnScore(
  accessToken: string,
  contact: string
): Promise<ChurnScore | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/churn/score?contact=" + encodeURIComponent(contact)
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
  const row = payload as Record<string, unknown>;
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    score: typeof row.score === "number" ? row.score : 0,
    tier: typeof row.tier === "string" ? row.tier : "healthy",
    reasons: churnReasonsOf(row),
    signals: churnSignalsOf(row),
  };
}

export async function getChurnRadar(
  accessToken: string,
  limit = 10
): Promise<ChurnRadar | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/churn/radar?limit=" + encodeURIComponent(String(limit))
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
  const row = payload as Record<string, unknown>;
  const rawContacts = Array.isArray(row.contacts) ? row.contacts : [];
  const counts =
    row.counts !== null && typeof row.counts === "object"
      ? (row.counts as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    contacts: rawContacts
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        contactId: typeof item.contact_id === "string" ? item.contact_id : "",
        name: typeof item.name === "string" ? item.name : "",
        score: typeof item.score === "number" ? item.score : 0,
        tier: typeof item.tier === "string" ? item.tier : "healthy",
        reasons: churnReasonsOf(item),
      })),
    scored: typeof row.scored === "number" ? row.scored : 0,
    counts: tierCounts,
  };
}

export async function getChurnReport(
  accessToken: string
): Promise<ChurnReport | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/churn/report");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawReasons = Array.isArray(row.top_reasons) ? row.top_reasons : [];
  const tiers =
    row.tiers !== null && typeof row.tiers === "object"
      ? (row.tiers as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(tiers)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    scored: typeof row.scored === "number" ? row.scored : 0,
    avgScore: typeof row.avg_score === "number" ? row.avg_score : null,
    tiers: tierCounts,
    topReasons: rawReasons
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        reason: typeof item.reason === "string" ? item.reason : "",
        count: typeof item.count === "number" ? item.count : 0,
      })),
  };
}

export interface WinbackEntry {
  contactId: string;
  name: string;
  kind: string;
  days: number | null;
  item: string;
  priceText: string;
  total: number | null;
  message: string;
  waLink: string | null;
}

export interface WinbackQueue {
  cart: WinbackEntry[];
  reorder: WinbackEntry[];
  winback: WinbackEntry[];
  counts: Record<string, number>;
  scored: number;
}

export async function getWinbackQueue(
  accessToken: string
): Promise<WinbackQueue | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/winback/queue");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const entryOf = (raw: unknown): WinbackEntry | null => {
    if (raw === null || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    return {
      contactId: typeof item.contact_id === "string" ? item.contact_id : "",
      name: typeof item.name === "string" ? item.name : "",
      kind: typeof item.kind === "string" ? item.kind : "",
      days: typeof item.days === "number" ? item.days : null,
      item: typeof item.item === "string" ? item.item : "",
      priceText: typeof item.price_text === "string" ? item.price_text : "",
      total: typeof item.total === "number" ? item.total : null,
      message: typeof item.message === "string" ? item.message : "",
      waLink: typeof item.wa_link === "string" ? item.wa_link : null,
    };
  };
  const segmentOf = (raw: unknown): WinbackEntry[] =>
    Array.isArray(raw)
      ? raw
          .map(entryOf)
          .filter((entry): entry is WinbackEntry => entry !== null)
      : [];
  const segments =
    row.segments !== null && typeof row.segments === "object"
      ? (row.segments as Record<string, unknown>)
      : {};
  const counts =
    row.counts !== null && typeof row.counts === "object"
      ? (row.counts as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    cart: segmentOf(segments.cart),
    reorder: segmentOf(segments.reorder),
    winback: segmentOf(segments.winback),
    counts: tierCounts,
    scored: typeof row.scored === "number" ? row.scored : 0,
  };
}

export type WinbackSendResult =
  | { kind: "ok"; commandId: number }
  | { kind: "stale" }
  | { kind: "cooldown" }
  | { kind: "opted_out" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function sendWinbackEntry(
  accessToken: string,
  contactId: string,
  entryKind: string
): Promise<WinbackSendResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/winback/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, kind: entryKind }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const errorRaw =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).error
        : null;
    const errorCode =
      errorRaw !== null && typeof errorRaw === "object"
        ? (errorRaw as Record<string, unknown>).code
        : "";
    if (errorCode === "opted_out") return { kind: "opted_out" };
    return errorCode === "cooldown"
      ? { kind: "cooldown" }
      : { kind: "stale" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const row =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const commandId = typeof row.command_id === "number" ? row.command_id : 0;
  return { kind: "ok", commandId };
}

export interface RevenueSummary {
  days: number;
  revenue: number;
  revenuePrior: number;
  deltaPercent: number | null;
  orders: number;
  ordersPrior: number;
  aov: number | null;
  newBuyers: number;
  repeatBuyers: number;
  cancelled: number;
  cancelledRate: number | null;
  openCarts: number;
  pipelineValue: number;
  winbackSent: number;
}

export interface RevenueItem {
  name: string;
  units: number;
  revenue: number;
  buyers: number;
  unitsPrior: number;
  trend: string;
}

export async function getRevenueSummary(
  accessToken: string,
  days: number
): Promise<RevenueSummary | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/revenue/summary?days=" + encodeURIComponent(String(days))
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
  const row = payload as Record<string, unknown>;
  const num = (key: string): number =>
    typeof row[key] === "number" ? (row[key] as number) : 0;
  const opt = (key: string): number | null =>
    typeof row[key] === "number" ? (row[key] as number) : null;
  return {
    days: num("days"),
    revenue: num("revenue"),
    revenuePrior: num("revenue_prior"),
    deltaPercent: opt("delta_percent"),
    orders: num("orders"),
    ordersPrior: num("orders_prior"),
    aov: opt("aov"),
    newBuyers: num("new_buyers"),
    repeatBuyers: num("repeat_buyers"),
    cancelled: num("cancelled"),
    cancelledRate: opt("cancelled_rate"),
    openCarts: num("open_carts"),
    pipelineValue: num("pipeline_value"),
    winbackSent: num("winback_sent"),
  };
}

export async function getRevenueItems(
  accessToken: string,
  days: number
): Promise<RevenueItem[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/revenue/items?days=" + encodeURIComponent(String(days))
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
  const raw = (payload as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      units: typeof item.units === "number" ? item.units : 0,
      revenue: typeof item.revenue === "number" ? item.revenue : 0,
      buyers: typeof item.buyers === "number" ? item.buyers : 0,
      unitsPrior: typeof item.units_prior === "number" ? item.units_prior : 0,
      trend: typeof item.trend === "string" ? item.trend : "steady",
    }))
    .filter((item) => item.name);
}

export interface RestockItem {
  name: string;
  weeklyRate: number;
  revenue: number;
  buyers: number;
  lastSoldDays: number | null;
  recentUnits: number;
  priorUnits: number;
  sharePercent: number | null;
  trend: string;
}

export interface RestockRadar {
  stockUp: RestockItem[];
  watch: RestockItem[];
  slow: RestockItem[];
  counts: Record<string, number>;
  itemsSold: number;
  days: number;
}

function restockItemOf(raw: unknown): RestockItem | null {
  if (raw === null || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : "";
  if (!name) return null;
  return {
    name,
    weeklyRate: typeof item.weekly_rate === "number" ? item.weekly_rate : 0,
    revenue: typeof item.revenue === "number" ? item.revenue : 0,
    buyers: typeof item.buyers === "number" ? item.buyers : 0,
    lastSoldDays:
      typeof item.last_sold_days === "number" ? item.last_sold_days : null,
    recentUnits: typeof item.recent_units === "number" ? item.recent_units : 0,
    priorUnits: typeof item.prior_units === "number" ? item.prior_units : 0,
    sharePercent:
      typeof item.share_percent === "number" ? item.share_percent : null,
    trend: typeof item.trend === "string" ? item.trend : "steady",
  };
}

export async function getRestockRadar(
  accessToken: string,
  days: number
): Promise<RestockRadar | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/restock/radar?days=" + encodeURIComponent(String(days))
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
  const row = payload as Record<string, unknown>;
  const listOf = (raw: unknown): RestockItem[] =>
    Array.isArray(raw)
      ? raw
          .map(restockItemOf)
          .filter((item): item is RestockItem => item !== null)
      : [];
  const counts =
    row.counts !== null && typeof row.counts === "object"
      ? (row.counts as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    stockUp: listOf(row.stock_up),
    watch: listOf(row.watch),
    slow: listOf(row.slow),
    counts: tierCounts,
    itemsSold: typeof row.items_sold === "number" ? row.items_sold : 0,
    days: typeof row.days === "number" ? row.days : 0,
  };
}

export interface CustomerValue {
  contactId: string;
  totalSpent: number;
  orders: number;
  units: number;
  avgOrder: number | null;
  topItem: string;
  topItemUnits: number;
  medianGapDays: number | null;
  firstOrderDays: number | null;
  lastOrderDays: number | null;
  tier: string;
}

export interface ValueCustomer {
  contactId: string;
  name: string;
  totalSpent: number;
  orders: number;
  lastOrderDays: number | null;
  tier: string;
}

function valueBlockOf(row: Record<string, unknown>, contact: string): CustomerValue {
  const num = (key: string): number =>
    typeof row[key] === "number" ? (row[key] as number) : 0;
  const opt = (key: string): number | null =>
    typeof row[key] === "number" ? (row[key] as number) : null;
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    totalSpent: num("total_spent"),
    orders: num("orders"),
    units: num("units"),
    avgOrder: opt("avg_order"),
    topItem: typeof row.top_item === "string" ? row.top_item : "",
    topItemUnits: num("top_item_units"),
    medianGapDays: opt("median_gap_days"),
    firstOrderDays: opt("first_order_days"),
    lastOrderDays: opt("last_order_days"),
    tier: typeof row.tier === "string" ? row.tier : "new",
  };
}

export async function getCustomerValue(
  accessToken: string,
  contact: string
): Promise<CustomerValue | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/value/summary?contact=" + encodeURIComponent(contact)
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
  return valueBlockOf(payload as Record<string, unknown>, contact);
}

export async function getTopCustomers(
  accessToken: string,
  limit = 10
): Promise<{ customers: ValueCustomer[]; scored: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/value/top?limit=" + encodeURIComponent(String(limit))
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
  const row = payload as Record<string, unknown>;
  const raw = Array.isArray(row.customers) ? row.customers : [];
  return {
    customers: raw
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => {
        const num = (key: string): number =>
          typeof item[key] === "number" ? (item[key] as number) : 0;
        const opt = (key: string): number | null =>
          typeof item[key] === "number" ? (item[key] as number) : null;
        return {
          contactId:
            typeof item.contact_id === "string" ? item.contact_id : "",
          name: typeof item.name === "string" ? item.name : "",
          totalSpent: num("total_spent"),
          orders: num("orders"),
          lastOrderDays: opt("last_order_days"),
          tier: typeof item.tier === "string" ? item.tier : "new",
        };
      })
      .filter((item) => item.contactId),
    scored: typeof row.scored === "number" ? row.scored : 0,
  };
}

export async function deleteSequence(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SequenceEnrollmentRow {
  id: number;
  contact_name: string | null;
  contact_id: string;
  current_step: number;
  status: string;
  next_at: string | null;
  enrolled_at: string | null;
  /** §236: why a "stopped" enrollment stopped. */
  stop_reason: SequenceStopReason | null;
}

export type SequenceStopReason = "opted_out" | "purchased" | "human_took_over";

export async function listSequenceEnrollments(
  accessToken: string,
  sequenceId: number
): Promise<SequenceEnrollmentRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments"
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
  const rawList = (payload as Record<string, unknown>).enrollments;
  if (!Array.isArray(rawList)) return null;
  const enrollments: SequenceEnrollmentRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    enrollments.push({
      id: row.id,
      contact_name: typeof row.contact_name === "string" ? row.contact_name : null,
      contact_id: typeof row.contact_id === "string" ? row.contact_id : "",
      current_step: typeof row.current_step === "number" ? row.current_step : 0,
      status: typeof row.status === "string" ? row.status : "active",
      next_at: typeof row.next_at === "string" ? row.next_at : null,
      enrolled_at: typeof row.enrolled_at === "string" ? row.enrolled_at : null,
      stop_reason:
        row.stop_reason === "opted_out" ||
        row.stop_reason === "purchased" ||
        row.stop_reason === "human_took_over"
          ? row.stop_reason
          : null,
    });
  }
  return enrollments;
}

export type EnrollmentPauseResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function pauseSequenceEnrollment(
  accessToken: string,
  sequenceId: number,
  enrollmentId: number
): Promise<EnrollmentPauseResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) +
        "/enrollments/" + String(enrollmentId) + "/pause",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function resumeSequenceEnrollment(
  accessToken: string,
  sequenceId: number,
  enrollmentId: number
): Promise<EnrollmentPauseResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) +
        "/enrollments/" + String(enrollmentId) + "/resume",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export type EnrollmentBulkResult =
  | { kind: "ok"; count: number }
  | { kind: "unavailable" };

export async function pauseAllEnrollments(
  accessToken: string,
  sequenceId: number
): Promise<EnrollmentBulkResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments/pause-all",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const count =
    payload !== null && typeof payload === "object"
      ? (payload as { paused?: unknown }).paused
      : null;
  return {
    kind: "ok",
    count: typeof count === "number" ? count : 0,
  };
}

export async function resumeAllEnrollments(
  accessToken: string,
  sequenceId: number
): Promise<EnrollmentBulkResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments/resume-all",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const count =
    payload !== null && typeof payload === "object"
      ? (payload as { resumed?: unknown }).resumed
      : null;
  return {
    kind: "ok",
    count: typeof count === "number" ? count : 0,
  };
}

export type WebhookTestResult =
  | { kind: "ok"; delivered: boolean; statusCode: number | null; error: string | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function testWebhook(
  accessToken: string,
  id: number
): Promise<WebhookTestResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) + "/test",
      { method: "POST" }
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
  if (typeof p.delivered !== "boolean") return { kind: "unavailable" };
  return {
    kind: "ok",
    delivered: p.delivered,
    statusCode: typeof p.status_code === "number" ? p.status_code : null,
    error: typeof p.error === "string" ? p.error : null,
  };
}

export type WebhookRetryResult =
  | { kind: "ok"; delivered: boolean; statusCode: number | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function retryWebhookDelivery(
  accessToken: string,
  id: number,
  deliveryId: number
): Promise<WebhookRetryResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) +
        "/deliveries/" + String(deliveryId) + "/retry",
      { method: "POST" }
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
  if (typeof p.delivered !== "boolean") return { kind: "unavailable" };
  return {
    kind: "ok",
    delivered: p.delivered,
    statusCode: typeof p.status_code === "number" ? p.status_code : null,
  };
}

export type SequenceEnrollResult =
  | { kind: "ok"; enrolled: number; skipped: string[] }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function enrollSequenceContacts(
  accessToken: string,
  sequenceId: number,
  contacts: string[]
): Promise<SequenceEnrollResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments",
      { method: "POST", body: JSON.stringify({ contacts }) }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  if (typeof p.enrolled !== "number") return { kind: "unavailable" };
  return {
    kind: "ok",
    enrolled: p.enrolled,
    skipped: Array.isArray(p.skipped)
      ? p.skipped.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export type SequenceCancelResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function cancelSequenceEnrollment(
  accessToken: string,
  sequenceId: number,
  enrollmentId: number
): Promise<SequenceCancelResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) +
        "/enrollments/" + String(enrollmentId),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
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

// ---------------------------------------------------------------------------
// Approvals (D3): high-risk actions wait for an owner yes/no — in the
// portal or over WhatsApp with a plain 1 / 0 reply.
// ---------------------------------------------------------------------------

export type ApprovalKind =
  | "action"
  | "workflow_step"
  | "customer_request"
  | "config_change"
  | "other";

export interface ApprovalImpact {
  effect: string;
  onReject: string;
  money: Record<string, number>;
  action?: string;
}

export interface Approval {
  id: number;
  conversationId: number | null;
  contactId: string;
  contactName: string | null;
  action: string;
  summary: string;
  customerQuery: string | null;
  status: string;
  source: string;
  refCode: string;
  decidedBy: string | null;
  decidedVia: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  kind: ApprovalKind;
  kindLabel: string;
  risk: string;
  impact: ApprovalImpact;
  edits: Record<string, unknown>;
  decisionNote: string | null;
  customerReply: string | null;
  outcome: string | null;
  outcomeDetail: string | null;
  canReply: boolean;
}

export interface ApprovalField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "items";
  value: unknown;
  columns?: { key: string; type: "text" | "number" | "boolean" }[];
}

export interface ApprovalDetail extends Approval {
  editable: ApprovalField[];
  evidence: Record<string, unknown>;
  canDecide: boolean;
}

export interface ApprovalsList {
  approvals: Approval[];
  kinds: { key: string; label: string }[];
}

export interface ApprovalDecision {
  status?: string;
  outcome: string;
  outcomeDetail: string;
}

export interface ApprovalsConfig {
  approvalNumber: string;
  autoExpireHours: number;
  selfChatAvailable: boolean;
}

/** camelCase (Control Plane today) or snake_case (older builds). */
function pickKey(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function mapApproval(row: Record<string, unknown>): Approval {
  const conversationId = pickKey(row, "conversationId", "conversation_id");
  const impact = asRecord(row.impact);
  const money: Record<string, number> = {};
  for (const [key, value] of Object.entries(asRecord(impact.money))) {
    if (typeof value === "number" && Number.isFinite(value)) money[key] = value;
  }
  return {
    id: Number(row.id || 0),
    conversationId:
      conversationId === null || conversationId === undefined
        ? null
        : Number(conversationId),
    contactId: String(pickKey(row, "contactId", "contact_id") || ""),
    contactName: textOrNull(pickKey(row, "contactName", "contact_name")),
    action: String(row.action || ""),
    summary: String(row.summary || ""),
    customerQuery: textOrNull(pickKey(row, "customerQuery", "customer_query")),
    status: String(row.status || "pending"),
    source: String(row.source || "ai"),
    refCode: String(pickKey(row, "refCode", "ref_code") || ""),
    decidedBy: textOrNull(pickKey(row, "decidedBy", "decided_by")),
    decidedVia: textOrNull(pickKey(row, "decidedVia", "decided_via")),
    decidedAt: textOrNull(pickKey(row, "decidedAt", "decided_at")),
    expiresAt: textOrNull(pickKey(row, "expiresAt", "expires_at")),
    createdAt: textOrNull(pickKey(row, "createdAt", "created_at")),
    kind: String(row.kind || "other") as ApprovalKind,
    kindLabel: String(pickKey(row, "kindLabel", "kind_label") || "Other"),
    risk: String(row.risk || ""),
    impact: {
      effect: String(impact.effect || ""),
      onReject: String(pickKey(impact, "onReject", "on_reject") || ""),
      money,
      action: impact.action ? String(impact.action) : undefined,
    },
    edits: asRecord(row.edits),
    decisionNote: textOrNull(pickKey(row, "decisionNote", "decision_note")),
    customerReply: textOrNull(pickKey(row, "customerReply", "customer_reply")),
    outcome: textOrNull(row.outcome),
    outcomeDetail: textOrNull(pickKey(row, "outcomeDetail", "outcome_detail")),
    canReply: pickKey(row, "canReply", "can_reply") !== false,
  };
}

export async function listApprovals(
  accessToken: string,
  status: string,
  kind = ""
): Promise<ApprovalsList | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/approvals?status=" + encodeURIComponent(status) +
        (kind ? "&kind=" + encodeURIComponent(kind) : ""),
      { method: "GET" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  if (!Array.isArray(payload.approvals)) return null;
  const kinds: unknown[] = Array.isArray(payload.kinds) ? payload.kinds : [];
  return {
    approvals: payload.approvals.map((row: unknown) => mapApproval(asRecord(row))),
    kinds: kinds
      .map((item) => asRecord(item))
      .map((item) => ({ key: String(item.key || ""), label: String(item.label || "") }))
      .filter((item) => item.key),
  };
}

export async function getApproval(
  accessToken: string,
  approvalId: number
): Promise<ServiceResult<ApprovalDetail>> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken, "api/v1/portal/approvals/" + approvalId, { method: "GET" });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  const result = await serviceResult<{ approval?: unknown }>(response);
  if (result.kind !== "ok") return result;
  const row = asRecord(result.data.approval);
  if (!row.id) return { kind: "unavailable" };
  return {
    kind: "ok",
    data: {
      ...mapApproval(row),
      editable: Array.isArray(row.editable) ? (row.editable as ApprovalField[]) : [],
      evidence: asRecord(row.evidence),
      canDecide: row.canDecide === true,
    },
  };
}

export async function decideApproval(
  accessToken: string,
  approvalId: number,
  decision: {
    decision: "approve" | "reject";
    note?: string;
    reply?: string;
    args?: Record<string, unknown>;
  }
): Promise<ServiceResult<ApprovalDecision>> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/approvals/" + approvalId + "/decide",
      { method: "POST", body: JSON.stringify(decision) }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return serviceResult<ApprovalDecision>(response);
}

export async function retryApproval(
  accessToken: string,
  approvalId: number
): Promise<ServiceResult<ApprovalDecision>> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/approvals/" + approvalId + "/retry",
      { method: "POST", body: "{}" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return serviceResult<ApprovalDecision>(response);
}

// ---------------------------------------------------------------------------
// Config snapshots (§224): automatic + saved snapshots of the workspace
// settings, compare with today, restore all or some areas.
// ---------------------------------------------------------------------------

export interface ConfigSnapshot {
  id: number;
  label: string;
  reason: string;
  reasonLabel: string;
  createdBy: string | null;
  createdAt: string | null;
  areas: string[];
}

export interface ConfigSnapshotChange {
  field: string;
  current: string;
  snapshot: string;
}

export interface ConfigSnapshotArea {
  key: string;
  label: string;
  inSnapshot: boolean;
  changes: ConfigSnapshotChange[];
}

export interface ConfigSnapshotList {
  snapshots: ConfigSnapshot[];
  areas: { key: string; label: string }[];
  autoMinutes: number;
  keep: number;
  canRestore: boolean;
}

export interface ConfigRestoreResult {
  backupId: number;
  areas: {
    key: string;
    label: string;
    status: string;
    detail?: string;
    changed?: number;
    added?: number;
    archived?: number;
  }[];
}

async function snapshotRequest<T>(
  accessToken: string,
  path: string,
  init: RequestInit
): Promise<ServiceResult<T>> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken, "api/v1/portal/snapshots" + path, init);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return serviceResult<T>(response);
}

export function listConfigSnapshots(accessToken: string) {
  return snapshotRequest<ConfigSnapshotList>(accessToken, "", { method: "GET" });
}

export function createConfigSnapshot(accessToken: string, label: string) {
  return snapshotRequest<{ ok: boolean; snapshot: ConfigSnapshot }>(
    accessToken, "", { method: "POST", body: JSON.stringify({ label }) });
}

export function getConfigSnapshot(accessToken: string, snapshotId: number) {
  return snapshotRequest<{
    snapshot: ConfigSnapshot & { compare: ConfigSnapshotArea[] };
  }>(accessToken, "/" + snapshotId, { method: "GET" });
}

export function restoreConfigSnapshot(
  accessToken: string,
  snapshotId: number,
  areas: string[] | null
) {
  return snapshotRequest<ConfigRestoreResult>(
    accessToken,
    "/" + snapshotId + "/restore",
    { method: "POST", body: JSON.stringify(areas === null ? {} : { areas }) }
  );
}

export function deleteConfigSnapshot(accessToken: string, snapshotId: number) {
  return snapshotRequest<{ ok: boolean }>(
    accessToken, "/" + snapshotId, { method: "DELETE" });
}

export async function getApprovalsConfig(
  accessToken: string
): Promise<ApprovalsConfig | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken, "api/v1/portal/approvals/config", { method: "GET" });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    approvalNumber: String(row.approvalNumber || ""),
    autoExpireHours: Number(row.autoExpireHours || 24),
    selfChatAvailable: row.selfChatAvailable === true,
  };
}

export async function saveApprovalsConfig(
  accessToken: string,
  approvalNumber: string,
  autoExpireHours: number
): Promise<"ok" | "bad_request" | "forbidden" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/approvals/config",
      {
        method: "PUT",
        body: JSON.stringify({
          approvalNumber,
          autoExpireHours,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return "bad_request";
  if (response.status === 403) return "forbidden";
  if (!response.ok) return null;
  return "ok";
}

// ---------------------------------------------------------------------------
// Policy hub (engine 8): one read-only summary of every rule family +
// the shared evaluator's dry-run endpoint.
// ---------------------------------------------------------------------------

export interface PolicyFamily {
  ruleSet: string;
  label: string;
  href: string;
  count: number;
  summary: string;
}

export async function listPolicyRules(
  accessToken: string
): Promise<PolicyFamily[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/policy/rules",
      { method: "GET" });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).families
    : null;
  if (!Array.isArray(raw)) return null;
  return raw.map((row: Record<string, unknown>) => ({
    ruleSet: String(row.ruleSet || ""),
    label: String(row.label || ""),
    href: String(row.href || "/dashboard"),
    count: Number(row.count || 0),
    summary: String(row.summary || ""),
  }));
}

export async function testPolicyRule(
  accessToken: string,
  rules: Record<string, unknown>,
  context: Record<string, unknown>
): Promise<boolean | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/policy/evaluate",
      {
        method: "POST",
        body: JSON.stringify({ rules, context }),
      });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return (payload as Record<string, unknown>).matched === true;
}

// ---------------------------------------------------------------------------
// Business Brain v2: structured business facts (policies / SOPs / pricing)
// ---------------------------------------------------------------------------

export interface BrainFact {
  id: number;
  kind: "policy" | "sop" | "pricing" | "refund" | "escalation" | "hours";
  label: string;
  content: string;
  keywords: string;
  isActive: boolean;
  updatedAt: string;
}

export async function listBrainFacts(
  accessToken: string
): Promise<BrainFact[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/facts");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    facts?: Array<Record<string, unknown>>;
  } | null;
  if (!payload?.facts) return null;
  return payload.facts.map((row) => ({
    id: Number(row.id || 0),
    kind: (String(row.kind || "policy") as BrainFact["kind"]),
    label: String(row.label || ""),
    content: String(row.content || ""),
    keywords: String(row.keywords || ""),
    isActive: Boolean(row.is_active),
    updatedAt: String(row.updated_at || ""),
  }));
}

export async function saveBrainFact(
  accessToken: string,
  fact: {
    id?: number;
    kind: BrainFact["kind"];
    label: string;
    content: string;
    keywords?: string;
    isActive?: boolean;
  }
): Promise<BrainFact | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: fact.id ?? 0,
        kind: fact.kind,
        label: fact.label,
        content: fact.content,
        keywords: fact.keywords ?? "",
        is_active: fact.isActive ?? true,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    fact?: Record<string, unknown>;
  } | null;
  if (!payload?.fact) return null;
  return {
    id: Number(payload.fact.id || 0),
    kind: (String(payload.fact.kind || "policy") as BrainFact["kind"]),
    label: String(payload.fact.label || ""),
    content: String(payload.fact.content || ""),
    keywords: String(payload.fact.keywords || ""),
    isActive: Boolean(payload.fact.is_active),
    updatedAt: "",
  };
}

export async function deleteBrainFact(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/brain/facts?id=" + encodeURIComponent(String(id)),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Customer identity (cross-channel identity resolution)
// ---------------------------------------------------------------------------

export type IdentityChannel =
  | "whatsapp"
  | "phone"
  | "email"
  | "instagram"
  | "facebook"
  | "tiktok"
  | "web"
  | "other";

export interface IdentityHandle {
  id: number;
  identity_id: number;
  channel: IdentityChannel;
  handle: string;
  raw_handle: string;
  confidence: number;
  source: "owner" | "system" | "legacy" | "import" | "adapter";
  created_at: string | null;
}

export interface IdentitySuggestion {
  contact_a: string;
  name_a: string;
  contact_b: string;
  name_b: string;
  reason: "same_phone" | "same_name";
  confidence: number;
}

export interface CustomerIdentity {
  id: number;
  display_name: string;
  primary_contact: string;
  status: "active" | "merged";
  handles: IdentityHandle[];
  contacts: string[];
  linked: { contact_id: string; name: string }[];
  created_at: string | null;
  updated_at: string | null;
}

export interface CustomerIdentityPayload {
  identity: CustomerIdentity;
  suggestions: IdentitySuggestion[];
  channels: IdentityChannel[];
  limits: { max_handles: number };
}

export interface IdentityDuplicatesPayload {
  suggestions: IdentitySuggestion[];
  scanned: number;
  linked_identities: number;
  total: number;
}

export type AddIdentityHandleResult =
  | { kind: "ok"; handle: IdentityHandle }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string; other_contact: string }
  | { kind: "unavailable" };

async function identityMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
    other_contact?: unknown;
  } | null;
  return payload && payload.error && typeof payload.error.message === "string"
    ? payload.error.message
    : "";
}

export async function getCustomerIdentity(
  accessToken: string,
  contact: string
): Promise<CustomerIdentityPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/identity?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as
    CustomerIdentityPayload | null;
}

export async function addIdentityHandle(
  accessToken: string,
  contact: string,
  channel: string,
  handle: string
): Promise<AddIdentityHandleResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/identity/handles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, channel, handle }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
      other_contact?: unknown;
    } | null;
    return {
      kind: "conflict",
      message:
        payload && payload.error && typeof payload.error.message === "string"
          ? payload.error.message
          : "That handle already belongs to another customer.",
      other_contact:
        payload && typeof payload.other_contact === "string"
          ? payload.other_contact
          : "",
    };
  }
  if (response.status === 400) {
    return {
      kind: "invalid",
      message: (await identityMessage(response)) || "That handle is not valid.",
    };
  }
  if (!response.ok) return { kind: "unavailable" };
  const payload = (await response.json().catch(() => null)) as {
    handle?: IdentityHandle;
  } | null;
  if (!payload || !payload.handle) return { kind: "unavailable" };
  return { kind: "ok", handle: payload.handle };
}

export async function removeIdentityHandle(
  accessToken: string,
  id: number
): Promise<"ok" | "not_found" | "protected" | "unavailable"> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/identity/handles/" + id,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return "unavailable";
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "protected";
  return response.ok ? "ok" : "unavailable";
}

export async function mergeIdentity(
  accessToken: string,
  keep: string,
  merge: string
): Promise<{ identity: CustomerIdentity } | { error: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/identity/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep, merge }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
    return {
      error: (await identityMessage(response)) || "Those contacts cannot be linked.",
    };
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    identity?: CustomerIdentity;
  } | null;
  return payload && payload.identity ? { identity: payload.identity } : null;
}

export async function splitIdentity(
  accessToken: string,
  contact: string
): Promise<{ identity: CustomerIdentity } | { error: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/identity/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400 || response.status === 404) {
    return {
      error:
        (await identityMessage(response)) ||
        "This contact is not linked to another contact.",
    };
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    identity?: CustomerIdentity;
  } | null;
  return payload && payload.identity ? { identity: payload.identity } : null;
}

export async function listIdentityDuplicates(
  accessToken: string,
  limit = 50
): Promise<IdentityDuplicatesPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/identity/duplicates?limit=" + encodeURIComponent(String(limit))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as
    IdentityDuplicatesPayload | null;
}

export async function dismissIdentityPair(
  accessToken: string,
  contactA: string,
  contactB: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/identity/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_a: contactA, contact_b: contactB }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Knowledge engine (document / page sources, versions, retrieval tester)
// ---------------------------------------------------------------------------

export type KbSourceKind = "text" | "file" | "url";
export type KbSourceStatus = "draft" | "published" | "paused";

export interface KbSource {
  id: number;
  title: string;
  kind: KbSourceKind;
  origin: string;
  status: KbSourceStatus;
  version: number;
  chunk_count: number;
  char_count: number;
  last_error: string;
  stale: boolean;
  /** §219: web pages only - re-fetched automatically in the background. */
  auto_refresh?: boolean;
  /** Last automatic check that found the page unchanged (or last index). */
  checked_at?: string | null;
  ingested_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface KbHealth {
  sources: number;
  published: number;
  drafts: number;
  paused: number;
  chunks: number;
  errors: number;
  stale: number;
}

export interface KbLimits {
  max_sources: number;
  max_chars: number;
  chunk_chars: number;
  max_versions: number;
  kinds: KbSourceKind[];
  /** §219: automatic refresh interval (OF_KB_AUTO_REFRESH_HOURS). */
  refresh_hours?: number;
  /** §219: PDF / Word import limits from the Control Plane. */
  file_types?: string[];
  file_bytes_max?: number;
  pdf_pages_max?: number;
  pdf_available?: boolean;
  /** §221: reading scanned pages / images with the platform vision AI. */
  ocr_available?: boolean;
  ocr_reason?: string;
  ocr_pages_max?: number;
  ocr_pages_per_call?: number;
  image_types?: string[];
}

export interface KbSourcesPayload {
  sources: KbSource[];
  health: KbHealth;
  limits: KbLimits;
}

export interface KbSourceVersion {
  version: number;
  chunk_count: number;
  char_count: number;
  note: string;
  created_at: string | null;
}

export interface KbHit {
  kind: "entry" | "chunk";
  id: number;
  title: string;
  content: string;
  source_id: number;
  source: string;
  position: number;
  score: number;
  matched: string[];
  /** D1 hybrid retrieval: which ranker found the hit. */
  via?: "keyword" | "semantic" | "both";
  /** Cosine similarity (0..1) when the semantic index matched, else null. */
  semantic?: number | null;
}

export interface KbSemanticStatus {
  active: boolean;
  reason: "active" | "off" | "no_key" | "llm_disabled" | string;
  mode: string;
  model: string;
  dimensions: number;
  min_similarity: number;
  key_source: string;
  total: number;
  indexed: number;
  pending: number;
  coverage: number;
  running: boolean;
  provider_cooldown: boolean;
  last_sync_at: string | null;
  last_error: string;
  last_embedded: number;
  last_reused: number;
  started?: boolean;
}

export type KbSemanticSyncResult =
  | { kind: "ok"; status: KbSemanticStatus }
  | { kind: "invalid"; code: string; message: string; status: number }
  | { kind: "unavailable" };

export async function getKbSemanticStatus(
  accessToken: string
): Promise<KbSemanticStatus | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb/semantic");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as KbSemanticStatus | null;
}

export async function syncKbSemantic(
  accessToken: string
): Promise<KbSemanticSyncResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/semantic/sync",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  const payload = (await response.json().catch(() => null)) as
    | (KbSemanticStatus & { error?: { code?: string; message?: string } })
    | null;
  if (response.ok && payload) return { kind: "ok", status: payload };
  if (response.status >= 400 && response.status < 500) {
    return {
      kind: "invalid",
      code: payload?.error?.code || "bad_request",
      message: payload?.error?.message || "Request rejected.",
      status: response.status,
    };
  }
  return { kind: "unavailable" };
}

export interface KbSearchPayload {
  query: string;
  tokens: string[];
  hits: KbHit[];
}

export type KbSourceResult =
  | { kind: "ok"; source: KbSource }
  | { kind: "invalid"; code: string; message: string; status: number }
  | { kind: "unavailable" };

async function kbSourceResult(response: Response): Promise<KbSourceResult> {
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  const payload = (await response.json().catch(() => null)) as {
    source?: KbSource;
    error?: { code?: unknown; message?: unknown };
  } | null;
  if (response.ok) {
    return payload && payload.source
      ? { kind: "ok", source: payload.source }
      : { kind: "unavailable" };
  }
  if (response.status === 400 || response.status === 404 || response.status === 409) {
    return {
      kind: "invalid",
      status: response.status,
      code:
        payload && payload.error && typeof payload.error.code === "string"
          ? payload.error.code
          : "bad_request",
      message:
        payload && payload.error && typeof payload.error.message === "string"
          ? payload.error.message
          : "That request could not be completed.",
    };
  }
  return { kind: "unavailable" };
}

export async function listKbSources(
  accessToken: string
): Promise<KbSourcesPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb/sources");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as KbSourcesPayload | null;
}

export async function createKbSource(
  accessToken: string,
  input: {
    kind: KbSourceKind;
    title?: string;
    text?: string;
    url?: string;
    filename?: string;
    auto_refresh?: boolean;
  }
): Promise<KbSourceResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return kbSourceResult(response);
}

export async function updateKbSource(
  accessToken: string,
  id: number,
  patch: { status?: KbSourceStatus; title?: string; auto_refresh?: boolean }
): Promise<KbSourceResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/sources/" + id,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return kbSourceResult(response);
}

export async function deleteKbSource(
  accessToken: string,
  id: number
): Promise<"ok" | "not_found" | "unavailable"> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/sources/" + id,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return "unavailable";
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "not_found";
  return response.ok ? "ok" : "unavailable";
}

export async function reindexKbSource(
  accessToken: string,
  id: number,
  text?: string,
  filename?: string
): Promise<KbSourceResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/sources/" + id + "/reindex",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          text ? (filename ? { text, filename } : { text }) : {}
        ),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return kbSourceResult(response);
}

export interface KbOcrPageResult {
  page: number;
  text: string;
  code: string;
  error: string;
}

export interface KbExtractPayload {
  filename: string;
  type: "pdf" | "docx" | "image";
  text: string;
  title: string;
  pages: number;
  truncated: boolean;
  chars: number;
  /** §221: pages without selectable text that can be read with AI. */
  ocr_pages?: number[];
  ocr_pages_skipped?: number;
  /** §221: per-page text (only when ocr_pages is not empty). */
  page_texts?: string[];
}

/** §221: the result of reading a few pages with the vision AI. */
export interface KbOcrPayload {
  filename: string;
  type: "pdf" | "image";
  pages: number;
  ocr: true;
  results: KbOcrPageResult[];
}

export type KbExtractResult =
  | { kind: "ok"; file: KbExtractPayload | KbOcrPayload }
  | { kind: "invalid"; code: string; message: string; status: number }
  | { kind: "unavailable" };

/** PDF parsing and AI page reading outlive the default 8 s timeout; the
 * website route allows 60 s (maxDuration), so stay just under it. */
function kbFileTimeoutMs(): number {
  const value = Number(process.env.OMNIFLOW_KB_FILE_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 5_000 && value <= 300_000
    ? value
    : 55_000;
}

/** §219: text of a PDF / Word file for review. §221: with `ocr`, reads
 * the given scanned PDF pages (or the uploaded image) with the platform
 * vision AI. Stores nothing. */
export async function extractKbFile(
  accessToken: string,
  filename: string,
  fileBase64: string,
  ocr?: { pages: number[] }
): Promise<KbExtractResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/extract",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          ocr
            ? { filename, file_base64: fileBase64, ocr: true, pages: ocr.pages }
            : { filename, file_base64: fileBase64 }
        ),
      },
      kbFileTimeoutMs()
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  const payload = (await response.json().catch(() => null)) as
    | ((KbExtractPayload | KbOcrPayload) & {
        error?: { code?: unknown; message?: unknown };
      })
    | null;
  if (
    response.ok &&
    payload &&
    ("ocr" in payload && payload.ocr === true
      ? Array.isArray(payload.results)
      : typeof (payload as KbExtractPayload).text === "string")
  ) {
    return { kind: "ok", file: payload };
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      kind: "invalid",
      status: response.status,
      code:
        payload?.error && typeof payload.error.code === "string"
          ? payload.error.code
          : "bad_request",
      message:
        payload?.error && typeof payload.error.message === "string"
          ? payload.error.message
          : "That file could not be read.",
    };
  }
  return { kind: "unavailable" };
}

export async function listKbSourceVersions(
  accessToken: string,
  id: number
): Promise<{ source: KbSource; versions: KbSourceVersion[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/sources/" + id + "/versions"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    source: KbSource;
    versions: KbSourceVersion[];
  } | null;
}

export async function rollbackKbSource(
  accessToken: string,
  id: number,
  version: number
): Promise<KbSourceResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/sources/" + id + "/rollback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return kbSourceResult(response);
}

export async function searchKnowledge(
  accessToken: string,
  query: string,
  n = 5
): Promise<KbSearchPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/search?q=" +
        encodeURIComponent(query) +
        "&n=" +
        encodeURIComponent(String(n))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as KbSearchPayload | null;
}

// ---------------------------------------------------------------------------
// Platform services (MASTER-UPGRADE): notifications, escalations, AI usage +
// unified AI audit (CP: portal_notify / portal_escalation / portal_ai_usage /
// portal_ai_audit).
// ---------------------------------------------------------------------------

export type NotifySeverity = "normal" | "high";

export interface NotifySettings {
  email_enabled: boolean;
  email_to: string;
  min_severity: NotifySeverity;
  kinds: Record<string, boolean>;
  /** §239 rate limits (per kind per hour / per day). */
  bell_per_hour: number;
  email_per_hour: number;
  email_per_day: number;
}

export interface NotifyKind {
  key: string;
  label: string;
  description: string;
}

export interface NotificationItem {
  id: number;
  kind: string;
  severity: NotifySeverity;
  title: string;
  detail: string;
  conversation_id: number | null;
  alert_id: number | null;
  email_to: string;
  email_status: string;
  email_error: string;
  created_at: string | null;
  in_app_status: string;
}

export interface NotificationsPayload {
  items: NotificationItem[];
  settings: NotifySettings;
  kinds: NotifyKind[];
  severities: NotifySeverity[];
  email_configured: boolean;
  limit_max: number;
  can_edit: boolean;
}

export interface NotifyTestResult {
  ok: boolean;
  result: {
    in_app: number | null;
    email: string;
    email_to: string;
    ledger_id: number | null;
    error: string;
  };
}

export type ServiceResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "invalid"; status: number; code: string; message: string }
  | { kind: "unavailable" };

async function serviceResult<T>(response: Response): Promise<ServiceResult<T>> {
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { code?: unknown; message?: unknown } })
    | null;
  if (response.ok) {
    return payload ? { kind: "ok", data: payload } : { kind: "unavailable" };
  }
  if (
    response.status === 400 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 409 ||
    response.status === 429
  ) {
    return {
      kind: "invalid",
      status: response.status,
      code:
        payload && payload.error && typeof payload.error.code === "string"
          ? payload.error.code
          : "bad_request",
      message:
        payload && payload.error && typeof payload.error.message === "string"
          ? payload.error.message
          : "That request could not be completed.",
    };
  }
  return { kind: "unavailable" };
}

export async function getNotifications(
  accessToken: string,
  limit = 30
): Promise<NotificationsPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/notifications?limit=" + encodeURIComponent(String(limit))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as NotificationsPayload | null;
}

export async function putNotificationSettings(
  accessToken: string,
  input: Partial<NotifySettings>
): Promise<ServiceResult<{ ok: boolean; settings: NotifySettings }>> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/notifications/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return serviceResult(response);
}

export async function sendTestNotification(
  accessToken: string,
  kind = "system"
): Promise<NotifyTestResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as NotifyTestResult | null;
}

export type EscalationStatus = "open" | "resolved";

export interface Escalation {
  id: number;
  conversation_id: number;
  contact_name: string;
  contact_id: string;
  reason: string;
  reason_label: string;
  source: string;
  severity: NotifySeverity;
  note: string;
  target_user_id: number | null;
  status: EscalationStatus;
  hits: number;
  created_at: string | null;
  updated_at: string | null;
  resolved_at: string | null;
  resolved_note: string;
}

export interface EscalationSummary {
  open: number;
  open_high: number;
  opened_7d: number;
  resolved_7d: number;
  avg_resolve_minutes: number | null;
  by_source: Record<string, number>;
  top_reasons: { label: string; count: number }[];
}

export interface EscalationsPayload {
  items: Escalation[];
  summary: EscalationSummary;
  sources: string[];
}

export async function listEscalations(
  accessToken: string,
  status: EscalationStatus | "all" = "open",
  limit = 50
): Promise<EscalationsPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/escalations?status=" +
        encodeURIComponent(status) +
        "&limit=" +
        encodeURIComponent(String(limit))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as EscalationsPayload | null;
}

export async function raiseEscalation(
  accessToken: string,
  input: { conversation_id: number; note?: string; user_id?: number }
): Promise<ServiceResult<{ ok: boolean; escalation: Record<string, unknown> }>> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/escalations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return serviceResult(response);
}

export async function resolveEscalation(
  accessToken: string,
  id: number,
  note = ""
): Promise<ServiceResult<{ ok: boolean; escalation: Record<string, unknown> }>> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/escalations/" + id + "/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return serviceResult(response);
}

export interface AiUsageTotals {
  calls: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens: number;
  avg_latency_ms: number;
  cost_usd: number | null;
  priced: boolean;
  unpriced_calls: number;
}

export interface AiUsagePayload {
  days: number;
  totals: AiUsageTotals;
  by_feature: { feature: string; label: string; calls: number; failed: number; tokens: number; cost_usd: number | null }[];
  by_model: { model: string; calls: number; failed: number; tokens: number; cost_usd: number | null }[];
  by_agent?: {
    agent_id: number | null;
    name: string;
    calls: number;
    failed: number;
    tokens: number;
    cost_usd: number | null;
    share: number;
  }[];
  by_day: { day: string; calls: number; tokens: number }[];
  prices_configured: boolean;
  features: { key: string; label: string }[];
}

export interface AiAuditItem {
  id: number;
  action: string;
  category: string;
  actor_kind: string;
  actor_user_id: number | null;
  conversation_id: number | null;
  note: string;
  created_at: string | null;
  /** §241: set when the row was written with an AI answer */
  trace?: { id: number; agent: { id: number; name: string } | null; model: string | null };
}

export interface AiAuditPayload {
  days: number;
  category: string;
  items: AiAuditItem[];
  categories: { key: string; label: string }[];
}

export interface AiOverviewPayload {
  days: number;
  total: number;
  by_category: { key: string; label: string; count: number }[];
  by_actor: Record<string, number>;
  approvals_pending: number | null;
  escalations: EscalationSummary | null;
  usage: { totals: AiUsageTotals; prices_configured: boolean } | null;
}

export async function getAiUsage(
  accessToken: string,
  days = 7
): Promise<AiUsagePayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/ai/usage?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AiUsagePayload | null;
}


// ---------------------------------------------------------------------------
// Live AI quality + human-labelled answer sets (CP: portal_ai_quality)
// ---------------------------------------------------------------------------

export interface AiQualitySignal {
  key: string;
  severity: string;
  title: string;
  detail: string;
}

export interface AiQualitySample {
  days: number;
  generatedAt: string;
  scope: string;
  traces: {
    total: number;
    byDecision: Record<string, number>;
    byKind: Record<string, number>;
    avgConfidence: number | null;
    groundedShare: number | null;
    citedShare: number | null;
    autoReplyBlockedShare: number | null;
    guardBlocked: number;
    handoffReasons: Record<string, number>;
  };
  usage: {
    calls: number;
    failed: number;
    failShare: number | null;
    avgLatencyMs: number;
  } | null;
  signals: AiQualitySignal[];
}

function normalizeAiQuality(payload: Record<string, unknown>): AiQualitySample {
  const traces = asRecord(payload.traces);
  const usage = payload.usage === null || payload.usage === undefined
    ? null
    : asRecord(payload.usage);
  const signalsRaw = Array.isArray(payload.signals) ? payload.signals : [];
  const signals: AiQualitySignal[] = [];
  for (const item of signalsRaw) {
    const row = asRecord(item);
    if (typeof row.title === "string") {
      signals.push({
        key: typeof row.key === "string" ? row.key : "",
        severity: typeof row.severity === "string" ? row.severity : "info",
        title: row.title,
        detail: typeof row.detail === "string" ? row.detail : "",
      });
    }
  }
  const numMap = (src: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    const rec = asRecord(src);
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  };
  return {
    days: typeof payload.days === "number" ? payload.days : 7,
    generatedAt:
      typeof payload.generated_at === "string" ? payload.generated_at : "",
    scope: typeof payload.scope === "string" ? payload.scope : "workspace",
    traces: {
      total: typeof traces.total === "number" ? traces.total : 0,
      byDecision: numMap(traces.by_decision),
      byKind: numMap(traces.by_kind),
      avgConfidence:
        typeof traces.avg_confidence === "number" ? traces.avg_confidence : null,
      groundedShare:
        typeof traces.grounded_share === "number" ? traces.grounded_share : null,
      citedShare:
        typeof traces.cited_share === "number" ? traces.cited_share : null,
      autoReplyBlockedShare:
        typeof traces.auto_reply_blocked_share === "number"
          ? traces.auto_reply_blocked_share
          : null,
      guardBlocked:
        typeof traces.guard_blocked === "number" ? traces.guard_blocked : 0,
      handoffReasons: numMap(traces.handoff_reasons),
    },
    usage: usage
      ? {
          calls: typeof usage.calls === "number" ? usage.calls : 0,
          failed: typeof usage.failed === "number" ? usage.failed : 0,
          failShare:
            typeof usage.fail_share === "number" ? usage.fail_share : null,
          avgLatencyMs:
            typeof usage.avg_latency_ms === "number" ? usage.avg_latency_ms : 0,
        }
      : null,
    signals,
  };
}

export async function getAiQualitySample(
  accessToken: string,
  days = 7
): Promise<AiQualitySample | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/ai/quality?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return normalizeAiQuality(payload);
}

export interface AiLabelItem {
  message: string;
  expectedDecision: "send" | "handoff" | "draft";
  expectedKeywords: string[];
  forbiddenPhrases: string[];
  note: string;
}

export interface AiLabelSet {
  id: number;
  name: string;
  notes: string;
  items: AiLabelItem[];
  itemCount: number;
  isActive: boolean;
  updatedAt: string;
}

function normalizeLabelItem(raw: unknown): AiLabelItem | null {
  const row = asRecord(raw);
  const message = typeof row.message === "string" ? row.message : "";
  if (!message) return null;
  const decision = String(row.expected_decision || row.expectedDecision || "send");
  const dec =
    decision === "handoff" || decision === "draft" || decision === "send"
      ? decision
      : "send";
  const kw = Array.isArray(row.expected_keywords)
    ? row.expected_keywords.filter((x): x is string => typeof x === "string")
    : Array.isArray(row.expectedKeywords)
      ? row.expectedKeywords.filter((x): x is string => typeof x === "string")
      : [];
  const fb = Array.isArray(row.forbidden_phrases)
    ? row.forbidden_phrases.filter((x): x is string => typeof x === "string")
    : Array.isArray(row.forbiddenPhrases)
      ? row.forbiddenPhrases.filter((x): x is string => typeof x === "string")
      : [];
  return {
    message,
    expectedDecision: dec,
    expectedKeywords: kw,
    forbiddenPhrases: fb,
    note: typeof row.note === "string" ? row.note : "",
  };
}

function normalizeLabelSet(raw: unknown): AiLabelSet | null {
  const row = asRecord(raw);
  const id = typeof row.id === "number" ? row.id : 0;
  if (id <= 0) return null;
  const itemsRaw = Array.isArray(row.items) ? row.items : [];
  const items: AiLabelItem[] = [];
  for (const item of itemsRaw) {
    const n = normalizeLabelItem(item);
    if (n) items.push(n);
  }
  return {
    id,
    name: typeof row.name === "string" ? row.name : "",
    notes: typeof row.notes === "string" ? row.notes : "",
    items,
    itemCount:
      typeof row.item_count === "number" ? row.item_count : items.length,
    isActive: row.is_active !== false,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

export async function listAiLabelSets(
  accessToken: string
): Promise<{ sets: AiLabelSet[]; decisions: string[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/ai/labels");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const setsRaw = Array.isArray(payload.sets) ? payload.sets : [];
  const sets: AiLabelSet[] = [];
  for (const item of setsRaw) {
    const n = normalizeLabelSet(item);
    if (n) sets.push(n);
  }
  const decisions = Array.isArray(payload.decisions)
    ? payload.decisions.filter((x): x is string => typeof x === "string")
    : ["send", "handoff", "draft"];
  return { sets, decisions };
}

function labelSetBody(input: {
  name: string;
  notes?: string;
  items: AiLabelItem[];
  isActive?: boolean;
}): Record<string, unknown> {
  return {
    name: input.name,
    notes: input.notes || "",
    is_active: input.isActive !== false,
    items: input.items.map((item) => ({
      message: item.message,
      expected_decision: item.expectedDecision,
      expected_keywords: item.expectedKeywords,
      forbidden_phrases: item.forbiddenPhrases,
      note: item.note,
    })),
  };
}

export async function createAiLabelSet(
  accessToken: string,
  input: { name: string; notes?: string; items: AiLabelItem[] }
): Promise<AiLabelSet | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/ai/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(labelSetBody(input)),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  return normalizeLabelSet(payload.set);
}

export async function updateAiLabelSet(
  accessToken: string,
  setId: number,
  input: { name: string; notes?: string; items: AiLabelItem[]; isActive?: boolean }
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/ai/labels/" + setId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(labelSetBody(input)),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function archiveAiLabelSet(
  accessToken: string,
  setId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/ai/labels/" + setId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface AiLabelRunResult {
  setId: number;
  name: string;
  mode: string;
  llmCalls: number;
  passed: number;
  total: number;
  score: number;
  status: string;
  results: {
    message: string;
    expectedDecision: string;
    actualDecision: string | null;
    passed: boolean;
    detail: string;
    liveReply: string | null;
  }[];
}

export async function runAiLabelSet(
  accessToken: string,
  setId: number,
  includeLive = false
): Promise<AiLabelRunResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/ai/labels/" + setId + "/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_live: includeLive === true }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const resultsRaw = Array.isArray(payload.results) ? payload.results : [];
  const results = [];
  for (const item of resultsRaw) {
    const row = asRecord(item);
    results.push({
      message: typeof row.message === "string" ? row.message : "",
      expectedDecision:
        typeof row.expected_decision === "string" ? row.expected_decision : "",
      actualDecision:
        typeof row.actual_decision === "string" ? row.actual_decision : null,
      passed: row.passed === true,
      detail: typeof row.detail === "string" ? row.detail : "",
      liveReply: typeof row.live_reply === "string" ? row.live_reply : null,
    });
  }
  return {
    setId: typeof payload.set_id === "number" ? payload.set_id : setId,
    name: typeof payload.name === "string" ? payload.name : "",
    mode: typeof payload.mode === "string" ? payload.mode : "deterministic",
    llmCalls: typeof payload.llm_calls === "number" ? payload.llm_calls : 0,
    passed: typeof payload.passed === "number" ? payload.passed : 0,
    total: typeof payload.total === "number" ? payload.total : 0,
    score: typeof payload.score === "number" ? payload.score : 0,
    status: typeof payload.status === "string" ? payload.status : "fail",
    results,
  };
}


export async function getAiAudit(
  accessToken: string,
  days = 7,
  category = "",
  limit = 100
): Promise<AiAuditPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/ai/audit?days=" +
        encodeURIComponent(String(days)) +
        "&category=" +
        encodeURIComponent(category) +
        "&limit=" +
        encodeURIComponent(String(limit))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return null;
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AiAuditPayload | null;
}

export async function getAiOverview(
  accessToken: string,
  days = 7
): Promise<AiOverviewPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/ai/overview?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AiOverviewPayload | null;
}

// ---------------------------------------------------------------------------
// Business Intelligence layer (CP: portal_bi) - insights, problem detector,
// AI quality, journey funnel in one report.
// ---------------------------------------------------------------------------

export interface BiTopic {
  key: string;
  label: string;
  count: number;
  share: number;
  prev_share: number;
  trend: "up" | "down" | "flat" | "new";
  conversations: number;
  examples: string[];
}

export interface BiProblem {
  key: string;
  title: string;
  severity: "critical" | "warn" | "info";
  evidence: Record<string, unknown>;
  impact: string;
  confidence: number;
  action: { label: string; href: string };
}

export interface BiFunnelStage {
  name: string;
  position: number;
  current: number;
  reached: number;
  conversion_from_previous: number | null;
  median_hours_to_next: number | null;
  stalled: number;
}

export interface BiReport {
  days: number;
  generated_at: string;
  insights: {
    days: number;
    topics: {
      messages: number;
      previous_messages: number;
      conversations: number;
      topics: BiTopic[];
      busy_hours: { hour: number; messages: number }[];
      tz_offset_hours: number;
    } | null;
    mix: {
      conversations: number;
      sentiment: Record<string, number>;
      purchase_intent: Record<string, number>;
      urgency: Record<string, number>;
      language: Record<string, number>;
      negative_share: number;
      high_purchase_share: number;
      urgent_share: number;
    } | null;
    gaps: { count: number; unresolved: number; top_topics: { key: string; label: string; count: number }[]; examples: string[] } | null;
    commerce: { cod: { confirmed: number; declined: number; decline_share: number }; negotiation_rounds: number; auto_answers: number } | null;
    checkout: { created: number; paid: number; conversion: number } | null;
    deliveries: { bookings: number; problem_bookings: number; problem_share: number; by_status: Record<string, number> } | null;
    service: { overdue_replies: number; overdue_hours: number; csat_avg: number | null; csat_answers: number } | null;
  };
  ai_quality: {
    days: number;
    traces: {
      decisions: number;
      auto_answers: number;
      drafts: number;
      sends: number;
      handoffs: number;
      handoff_share: number;
      reasons: Record<string, number>;
      policy_blocks: number;
      llm_unavailable: number;
      avg_confidence: number | null;
      grounded_share: number;
      cited_share: number;
      by_day: { day: string; send: number; handoff: number }[];
    } | null;
    resolution: {
      answered_conversations: number;
      escalated_after: number;
      resolved_share: number;
      csat_after_ai: number | null;
      csat_after_ai_n: number;
    } | null;
    handoffs: {
      current: number;
      previous: number;
      growth: number | null;
      open: number;
      open_unassigned: number;
      avg_resolve_minutes: number | null;
      by_source: Record<string, number>;
      reasons: { label: string; source: string; count: number }[];
    } | null;
    usage: {
      calls: number;
      failed: number;
      failed_share: number;
      avg_latency_ms: number;
      cost_usd: number | null;
      priced: boolean;
    } | null;
    unanswered: { count: number; examples: string[] };
  };
  funnel: {
    configured: boolean;
    days: number;
    stages: BiFunnelStage[];
    contacts: number;
    reached_first: number;
    reached_last: number;
    overall_conversion: number | null;
    stalled: number;
    stalled_share: number;
    stall_days: number;
    events: number;
  } | null;
  problems: BiProblem[];
  problem_counts: { critical: number; warn: number };
  topics: { key: string; label: string }[];
  narrative?: {
    mode: string;
    llm_used: boolean;
    headline: string;
    paragraphs: string[];
    bullets: string[];
    generated_at?: string;
  } | null;
}

export type BiThresholds = Record<string, number>;

export async function getBiThresholds(
  accessToken: string
): Promise<{
  thresholds: BiThresholds;
  defaults: BiThresholds;
  timezoneOffsetHours: number;
  keys: string[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/bi/thresholds");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const thresholds = asRecord(payload.thresholds);
  const defaults = asRecord(payload.defaults);
  const keys = Array.isArray(payload.keys)
    ? payload.keys.filter((k): k is string => typeof k === "string")
    : Object.keys(thresholds);
  const toNums = (src: Record<string, unknown>): BiThresholds => {
    const out: BiThresholds = {};
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  };
  return {
    thresholds: toNums(thresholds),
    defaults: toNums(defaults),
    timezoneOffsetHours:
      typeof payload.timezone_offset_hours === "number"
        ? payload.timezone_offset_hours
        : 5,
    keys,
  };
}

export async function saveBiThresholds(
  accessToken: string,
  thresholds: BiThresholds
): Promise<
  | { kind: "ok"; thresholds: BiThresholds }
  | { kind: "bad_request"; message: string }
  | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/bi/thresholds", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholds }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) {
    const payload = asRecord(await response.json().catch(() => null));
    const error = asRecord(payload.error);
    return {
      kind: "bad_request",
      message:
        typeof error.message === "string"
          ? error.message
          : "Check the threshold values.",
    };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const saved = asRecord(payload.thresholds);
  const out: BiThresholds = {};
  for (const [k, v] of Object.entries(saved)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return { kind: "ok", thresholds: out };
}

export interface WeeklyProblemsSettings {
  enabled: boolean;
  hour: number;
  weekday: number;
  lastSentDate: string | null;
}

export interface WeeklyProblemsWeekday {
  value: number;
  label: string;
}

export async function getWeeklyProblemsSettings(
  accessToken: string
): Promise<{
  settings: WeeklyProblemsSettings;
  weekdays: WeeklyProblemsWeekday[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/bi/weekly-problems"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const raw = asRecord(payload.settings);
  const weekdaysRaw = Array.isArray(payload.weekdays) ? payload.weekdays : [];
  const weekdays: WeeklyProblemsWeekday[] = [];
  for (const item of weekdaysRaw) {
    const row = asRecord(item);
    if (typeof row.value === "number" && typeof row.label === "string") {
      weekdays.push({ value: row.value, label: row.label });
    }
  }
  return {
    settings: {
      enabled: raw.enabled === true,
      hour: typeof raw.hour === "number" ? raw.hour : 9,
      weekday: typeof raw.weekday === "number" ? raw.weekday : 1,
      lastSentDate:
        typeof raw.last_sent_date === "string" && raw.last_sent_date
          ? raw.last_sent_date
          : null,
    },
    weekdays,
  };
}

export async function saveWeeklyProblemsSettings(
  accessToken: string,
  settings: { enabled: boolean; hour: number; weekday: number }
): Promise<
  | { kind: "ok"; settings: WeeklyProblemsSettings }
  | { kind: "bad_request"; message: string }
  | null
> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/bi/weekly-problems",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) {
    const payload = asRecord(await response.json().catch(() => null));
    const error = asRecord(payload.error);
    return {
      kind: "bad_request",
      message:
        typeof error.message === "string"
          ? error.message
          : "Check the schedule values.",
    };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const raw = asRecord(payload.settings);
  return {
    kind: "ok",
    settings: {
      enabled: raw.enabled === true,
      hour: typeof raw.hour === "number" ? raw.hour : settings.hour,
      weekday: typeof raw.weekday === "number" ? raw.weekday : settings.weekday,
      lastSentDate:
        typeof raw.last_sent_date === "string" && raw.last_sent_date
          ? raw.last_sent_date
          : null,
    },
  };
}

export async function sendWeeklyProblemsNow(
  accessToken: string
): Promise<{
  ok: boolean;
  title: string;
  problemCounts: { critical: number; warn: number };
} | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/bi/weekly-problems/send",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  const counts = asRecord(payload.problem_counts);
  return {
    ok: payload.ok === true,
    title: typeof payload.title === "string" ? payload.title : "",
    problemCounts: {
      critical: typeof counts.critical === "number" ? counts.critical : 0,
      warn: typeof counts.warn === "number" ? counts.warn : 0,
    },
  };
}

export async function getBiReport(
  accessToken: string,
  days = 7
): Promise<BiReport | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/bi/report?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as BiReport | null;
}

// ---------------------------------------------------------------------------
// D5 (§212): phone assistant + customer voice notes / images
// ---------------------------------------------------------------------------

export interface VoiceAiSettings {
  enabled: boolean;
  greeting: string;
  handoff_message: string;
  language: string;
  speech_model: string;
  tts_voice: string;
  max_turns: number;
  forward_to: string;
  /** Admin-assigned; read-only for the workspace. */
  number: string;
}

export interface VoiceAiStatus {
  active: boolean;
  /** active | off | platform_off | no_twilio | no_number | no_llm | autonomy */
  reason: string;
  number: string;
  twilio_ready: boolean;
  llm_ready: boolean;
  platform_ai_loop: string;
  autonomy: string;
}

export interface VoiceAiPayload {
  settings: VoiceAiSettings;
  status: VoiceAiStatus;
  languages?: string[];
  max_turns_limit?: number;
}

export interface VoiceTranscriptTurn {
  role: string;
  text: string;
}

export interface MediaAiSettings {
  voice_notes: boolean;
  images: boolean;
}

export interface MediaAiCapability {
  active: boolean;
  reason: string;
  model: string;
}

export interface MediaAiPayload {
  settings: MediaAiSettings;
  platform: { voice_notes: MediaAiCapability; images: MediaAiCapability };
  max_bytes?: number;
}

export interface MediaAiTestPayload {
  ok: boolean;
  kind: "audio" | "image";
  text: string;
  category?: string;
}

/** serviceResult plus the statuses D5 / §214 routes use for owner-facing
 * messages: 403 (owner sign-in required), 410 (customer file expired) and
 * 502 (provider error). */
async function voiceVisionResult<T>(response: Response): Promise<ServiceResult<T>> {
  if (response.status === 403 || response.status === 410 || response.status === 502) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    return {
      kind: "invalid",
      status: response.status,
      code:
        payload && payload.error && typeof payload.error.code === "string"
          ? payload.error.code
          : response.status === 403
            ? "forbidden"
            : response.status === 410
              ? "media_expired"
              : "provider_error",
      message:
        payload && payload.error && typeof payload.error.message === "string"
          ? payload.error.message
          : "That request could not be completed.",
    };
  }
  return serviceResult<T>(response);
}

async function voiceVisionCall<T>(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<ServiceResult<T>> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path, init);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return voiceVisionResult<T>(response);
}

export function getVoiceAiSettings(
  accessToken: string
): Promise<ServiceResult<VoiceAiPayload>> {
  return voiceVisionCall<VoiceAiPayload>(accessToken, "api/v1/portal/voice/ai-settings");
}

export function saveVoiceAiSettings(
  accessToken: string,
  settings: Partial<VoiceAiSettings>
): Promise<ServiceResult<VoiceAiPayload & { ok: boolean }>> {
  return voiceVisionCall(accessToken, "api/v1/portal/voice/ai-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

export function getVoiceCallTranscript(
  accessToken: string,
  sid: string
): Promise<ServiceResult<{ sid: string; turns: VoiceTranscriptTurn[] }>> {
  return voiceVisionCall(
    accessToken,
    "api/v1/portal/voice/calls/" + encodeURIComponent(sid) + "/transcript"
  );
}

export function getMediaAiSettings(
  accessToken: string
): Promise<ServiceResult<MediaAiPayload>> {
  return voiceVisionCall<MediaAiPayload>(accessToken, "api/v1/portal/media-ai/settings");
}

export function saveMediaAiSettings(
  accessToken: string,
  settings: Partial<MediaAiSettings>
): Promise<ServiceResult<MediaAiPayload & { ok: boolean }>> {
  return voiceVisionCall(accessToken, "api/v1/portal/media-ai/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

export function testMediaAi(
  accessToken: string,
  assetId: number
): Promise<ServiceResult<MediaAiTestPayload>> {
  return voiceVisionCall<MediaAiTestPayload>(accessToken, "api/v1/portal/media-ai/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id: assetId }),
  });
}

// ---------------------------------------------------------------------------
// §214: customer media store (copies of images / voice notes, fresh links)
// ---------------------------------------------------------------------------

export interface InboundMediaItem {
  id: number;
  /** §215: message the file arrived with (null when it cannot be matched). */
  message_id: number | null;
  /** image | audio | video | file */
  kind: string;
  mime: string;
  size_bytes: number;
  /** stored | link | too_large | failed | expired */
  status: string;
  /** copies_off | too_large | unsupported | download_failed | no_source | retention | quota */
  note: string;
  channel: string;
  has_copy: boolean;
  can_open: boolean;
  can_refresh: boolean;
  created_at: string | null;
}

export interface MediaStoreSettings {
  keep_copies: boolean;
  retention_days: number;
  quota_mb: number;
}

export interface MediaStorePayload {
  settings: MediaStoreSettings;
  usage: { used_bytes: number; copies: number; files: number };
  limits: {
    mode: string;
    max_file_bytes: number;
    max_quota_mb: number;
    max_retention_days: number;
  };
}

export function listConversationMedia(
  accessToken: string,
  conversationId: number
): Promise<ServiceResult<{ media: InboundMediaItem[] }>> {
  return voiceVisionCall(
    accessToken,
    "api/v1/portal/conversations/" + encodeURIComponent(String(conversationId)) + "/media"
  );
}

export function getInboundMediaLink(
  accessToken: string,
  mediaId: number
): Promise<ServiceResult<{ url: string; fresh: boolean }>> {
  return voiceVisionCall(
    accessToken,
    "api/v1/portal/inbound-media/" + encodeURIComponent(String(mediaId)) + "/link"
  );
}

export function deleteInboundMedia(
  accessToken: string,
  mediaId: number
): Promise<ServiceResult<{ ok: boolean }>> {
  return voiceVisionCall(
    accessToken,
    "api/v1/portal/inbound-media/" + encodeURIComponent(String(mediaId)),
    { method: "DELETE" }
  );
}

export function getMediaStoreSettings(
  accessToken: string
): Promise<ServiceResult<MediaStorePayload>> {
  return voiceVisionCall<MediaStorePayload>(accessToken, "api/v1/portal/media-store/settings");
}

export function saveMediaStoreSettings(
  accessToken: string,
  settings: Partial<MediaStoreSettings>
): Promise<ServiceResult<MediaStorePayload & { ok: boolean }>> {
  return voiceVisionCall(accessToken, "api/v1/portal/media-store/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

// ---------------------------------------------------------------------------
// Action Engine v2 + event catalog (§225): the execution ledger, the typed
// list of outbox events (webhook categories) and webhook dead-letter replay.
// ---------------------------------------------------------------------------

export interface ActionRun {
  id: number;
  action: string;
  label: string;
  status: string;
  risk: string;
  actor: string;
  actorKind: "workflow" | "approval" | "ai" | "person";
  conversationId: number | null;
  error: string | null;
  attempts: number;
  durationMs: number | null;
  approvalId: number | null;
  idempotent: boolean;
  args: Record<string, unknown>;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface ActionRunList {
  runs: ActionRun[];
  counts: Record<string, number>;
  keepDays: number;
}

export interface EventCatalogEntry {
  type: string;
  label: string;
  description: string;
  category: string;
  categoryLabel: string;
  workflowTriggers: string[];
}

export interface EventCatalog {
  events: EventCatalogEntry[];
  categories: { key: string; label: string; events: number }[];
}

async function portalService<T>(
  accessToken: string,
  path: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<ServiceResult<T>> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path, init, timeoutMs);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  return serviceResult<T>(response);
}

export function listActionRuns(accessToken: string, status: string) {
  const query = status ? "?status=" + encodeURIComponent(status) : "";
  return portalService<ActionRunList>(
    accessToken, "api/v1/portal/actions/runs" + query, { method: "GET" });
}

export function getEventCatalog(accessToken: string) {
  return portalService<EventCatalog>(
    accessToken, "api/v1/portal/events/catalog", { method: "GET" });
}

export function replayDeadWebhookDeliveries(accessToken: string, webhookId: number) {
  return portalService<{ ok: boolean; replayed: number }>(
    accessToken,
    "api/v1/portal/webhooks/" + webhookId + "/deliveries/replay-dead",
    { method: "POST", body: "{}" }
  );
}

// ---------------------------------------------------------------------------
// Website analyzer (§226): crawl the business website in short resumable
// steps, report what a customer would ask about, apply chosen findings.
// ---------------------------------------------------------------------------

export interface SiteEvidence {
  value: string;
  url: string;
  snippet: string;
}

export interface SiteIssue {
  severity: "high" | "medium" | "low" | "info";
  code: string;
  title: string;
  fix: string;
}

export interface SiteCatalogItem {
  name: string;
  price: number | null;
  currency: string;
  priceText: string;
  url: string;
  available: boolean | null;
  image: string;
  category: string;
  externalId: string;
}

export interface SiteFactSuggestion {
  key: string;
  kind: string;
  label: string;
  content: string;
  keywords: string;
  url: string;
  origin: "site" | "ai";
}

export interface SitePage {
  id: number;
  url: string;
  kind: string;
  status: number;
  title: string;
  words: number;
  loadMs: number;
  error: string;
}

export interface SiteReport {
  site: {
    url: string;
    host: string;
    platform: string;
    title: string;
    description: string;
    language: string;
    https: boolean;
    robotsBlocked: number;
  };
  business: {
    name: string;
    about: string;
    phones: SiteEvidence[];
    whatsapp: SiteEvidence[];
    emails: SiteEvidence[];
    address: SiteEvidence | null;
    hours: SiteEvidence[];
    socials: Record<string, string>;
    priceRange: string;
  };
  policies: {
    shipping: { url: string | null; delivery: SiteEvidence[]; fee: SiteEvidence[]; free: SiteEvidence[] };
    returns: { url: string | null; window: SiteEvidence[] };
    payments: { url: string | null; methods: string[]; cod: boolean; evidence: SiteEvidence[] };
    privacyUrl: string | null;
    termsUrl: string | null;
  };
  catalog: {
    source: "" | "shopify" | "woocommerce" | "pages";
    count: number;
    currency: string;
    priceMin: number | null;
    priceMax: number | null;
    priced: number;
    store: boolean;
    items: SiteCatalogItem[];
  };
  faqs: { q: string; a: string; url: string }[];
  pages: SitePage[];
  score: {
    total: number;
    parts: Record<string, number>;
    max: Record<string, number>;
    averageLoadMs: number;
  };
  issues: SiteIssue[];
  ai: { status: "off" | "used" | "failed" | "skipped"; summary: string; industry: string };
  suggestions: {
    facts: SiteFactSuggestion[];
    profile: Record<string, string>;
    kbPages: number[];
    faqSource: boolean;
  };
}

export interface SiteApplied {
  at: string;
  by: string;
  facts: number;
  profile: string[];
  knowledge: number;
  catalog: number;
}

export interface SiteScan {
  id: number;
  url: string;
  host: string;
  status: "crawling" | "analyzing" | "done" | "failed" | "cancelled";
  stage: string;
  maxPages: number;
  pagesDone: number;
  queued: number;
  error: string;
  score: number | null;
  report: SiteReport | null;
  applied: SiteApplied[];
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
}

export interface SiteScanSummary {
  id: number;
  url: string;
  host: string;
  status: SiteScan["status"];
  stage: string;
  maxPages: number;
  pagesDone: number;
  error: string;
  score: number | null;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface SiteScanList {
  scans: SiteScanSummary[];
  limits: { maxPages: number; defaultPages: number; scansPerDay: number; usedToday: number };
  suggestedUrl: string;
  canApply: boolean;
  aiAvailable: boolean;
}

export interface SiteScanDetail {
  scan: SiteScan;
  pages: SitePage[];
  canApply: boolean;
  busy?: boolean;
}

export interface SiteApplyChoice {
  facts: string[];
  profile: string[];
  kbPages: number[];
  faqSource: boolean;
  products: number[];
}

export interface SiteApplyResult {
  facts: number;
  profile: string[];
  knowledge: number;
  catalog: number;
  skipped: { area: string; item: string; reason: string }[];
}

const SITE_ANALYZER = "api/v1/portal/site-analyzer";
/** A scan step (and its one AI read) outlives the default 8 s timeout; the
 * start / step routes allow 60 s (maxDuration), so stay just under it. */
const SITE_STEP_TIMEOUT_MS = 55_000;

export function listSiteScans(accessToken: string) {
  return portalService<SiteScanList>(accessToken, SITE_ANALYZER, { method: "GET" });
}

export function startSiteScan(accessToken: string, url: string, maxPages: number) {
  return portalService<SiteScanDetail>(accessToken, SITE_ANALYZER, {
    method: "POST",
    body: JSON.stringify({ url, maxPages }),
  }, SITE_STEP_TIMEOUT_MS);
}

export function getSiteScan(accessToken: string, scanId: number) {
  return portalService<SiteScanDetail>(
    accessToken, SITE_ANALYZER + "/" + scanId, { method: "GET" });
}

export function stepSiteScan(accessToken: string, scanId: number) {
  return portalService<SiteScanDetail>(
    accessToken, SITE_ANALYZER + "/" + scanId + "/step", { method: "POST", body: "{}" },
    SITE_STEP_TIMEOUT_MS);
}

export function cancelSiteScan(accessToken: string, scanId: number) {
  return portalService<SiteScanDetail>(
    accessToken, SITE_ANALYZER + "/" + scanId + "/cancel", { method: "POST", body: "{}" });
}

export function deleteSiteScan(accessToken: string, scanId: number) {
  return portalService<{ ok: boolean }>(
    accessToken, SITE_ANALYZER + "/" + scanId, { method: "DELETE" });
}

export function applySiteScan(accessToken: string, scanId: number, choice: SiteApplyChoice) {
  return portalService<{ ok: boolean; result: SiteApplyResult }>(
    accessToken, SITE_ANALYZER + "/" + scanId + "/apply", {
      method: "POST",
      body: JSON.stringify(choice),
    });
}

// ---------------------------------------------------------------------------
// Ask OmniFlow AI (§227) - the team's in-portal assistant
// ---------------------------------------------------------------------------

export interface AssistantLink {
  label: string;
  href: string;
}

export interface AssistantMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  links: AssistantLink[];
  tools: { tool: string; ok: boolean }[];
  createdAt: string | null;
}

export interface AssistantProposal {
  id: number;
  threadId: number;
  messageId: number | null;
  kind: "config" | "action";
  tool: string;
  risk: "low" | "medium" | "high";
  status:
    | "pending"
    | "applied"
    | "done"
    | "approval"
    | "rejected"
    | "failed"
    | "undone"
    | "expired";
  summary: string;
  note: string;
  diff: { field: string; before: string; after: string }[];
  result: { message?: string; refCode?: string; approvalId?: number };
  tainted: boolean;
  snapshotId: number | null;
  canUndo: boolean;
  createdAt: string | null;
  decidedAt: string | null;
}

export interface AssistantThreadSummary {
  id: number;
  title: string;
  updatedAt: string | null;
}

export interface AssistantOverview {
  available: boolean;
  reason: string;
  canChange: boolean;
  changeRoles: string[];
  dailyLimit: number;
  usedToday: number;
  threads: AssistantThreadSummary[];
}

export interface AssistantThread {
  thread: AssistantThreadSummary;
  messages: AssistantMessage[];
  proposals: AssistantProposal[];
}

export interface AssistantAskResult extends AssistantThread {
  usedToday: number;
  dailyLimit: number;
}

export type AssistantDecision = "confirm" | "reject" | "undo";

const ASSISTANT = "api/v1/portal/assistant";
/** One question may run several model calls + lookups (CP budget 45 s);
 * the ask route allows 60 s (maxDuration), so stay just under it. */
const ASSISTANT_TIMEOUT_MS = 55_000;

/** Like portalService, but keeps the assistant's own 503 reasons (not set
 * up / the AI did not answer / platform limit) instead of a generic one. */
async function assistantService<T>(
  accessToken: string,
  path: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<ServiceResult<T>> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path, init, timeoutMs);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 503) {
    const payload = (await response.clone().json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    const code = payload?.error?.code;
    const message = payload?.error?.message;
    if (typeof code === "string" && code.startsWith("assistant_") && typeof message === "string") {
      return { kind: "invalid", status: 503, code, message };
    }
  }
  return serviceResult<T>(response);
}

export function getAssistant(accessToken: string) {
  return assistantService<AssistantOverview>(accessToken, ASSISTANT, { method: "GET" });
}

export function getAssistantThread(accessToken: string, threadId: number) {
  return assistantService<AssistantThread>(
    accessToken, ASSISTANT + "/threads/" + threadId, { method: "GET" });
}

export function askAssistant(accessToken: string, message: string, threadId: number | null) {
  return assistantService<AssistantAskResult>(accessToken, ASSISTANT + "/ask", {
    method: "POST",
    body: JSON.stringify(threadId ? { message, threadId } : { message }),
  }, ASSISTANT_TIMEOUT_MS);
}

export function deleteAssistantThread(accessToken: string, threadId: number) {
  return assistantService<{ ok: boolean }>(
    accessToken, ASSISTANT + "/threads/" + threadId, { method: "DELETE" });
}

export function decideAssistantProposal(
  accessToken: string,
  proposalId: number,
  decision: AssistantDecision
) {
  return assistantService<{ proposal: AssistantProposal }>(
    accessToken, ASSISTANT + "/proposals/" + proposalId + "/" + decision, {
      method: "POST",
      body: "{}",
    });
}

// ---------------------------------------------------------------------------
// §230 AI Sandbox: one customer message through the real automations inside a
// transaction that is always rolled back (nothing is sent or saved).
// ---------------------------------------------------------------------------

export type SandboxChannel =
  | "whatsapp"
  | "instagram"
  | "messenger"
  | "instagram_comment"
  | "facebook_comment";

export type SandboxTurn = { role: "customer" | "business"; text: string };

export type SandboxInput = {
  message: string;
  channel: SandboxChannel;
  customer_name?: string;
  history?: SandboxTurn[];
  force_auto?: boolean;
  simulate_workflows?: boolean;
};

export type SandboxExpectHandler =
  | ""
  | "any_reply"
  | "no_reply"
  | "brain"
  | "kb"
  | "away"
  | "cod"
  | "handoff";

export type SandboxScenarioInput = SandboxInput & {
  name: string;
  expect_handler: SandboxExpectHandler;
  expect_contains: string;
  expect_absent: string;
};

export type SandboxCheck = { label: string; ok: boolean };

export type SandboxScenario = {
  id: number;
  name: string;
  channel: SandboxChannel;
  customer_name: string;
  message: string;
  history: SandboxTurn[];
  force_auto: boolean;
  expect_handler: SandboxExpectHandler;
  expect_contains: string;
  expect_absent: string;
  last_pass: boolean | null;
  last_result: {
    handler?: string;
    replies?: { body: string }[];
    checks?: SandboxCheck[];
    error?: string;
  } | null;
  last_run_at: string | null;
};

export type SandboxSettings = {
  autonomy: string;
  effective: string;
  kill_switch: boolean;
  autonomy_cap: string;
};

export type SandboxOverview = {
  settings: SandboxSettings;
  channels: SandboxChannel[];
  expect_handlers: SandboxExpectHandler[];
  limits: { runs_per_hour: number; max_history: number; scenarios_max: number; message_max: number };
  scenarios: SandboxScenario[];
};

export type SandboxReply = { body: string; source: string; channel: string; to?: string };

export type SandboxResult = {
  ok: boolean;
  error: string;
  channel: SandboxChannel;
  message: string;
  outcome: { handler: string; handler_label: string; replies: SandboxReply[]; notes: string[] };
  ai: {
    decision: string;
    reason: string;
    reason_text: string;
    confidence: number | null;
    tools: string[];
    citations: unknown[];
    agent_id: number | null;
    llm_called: boolean | null;
  } | null;
  intelligence: Record<string, string | number | null> | null;
  routing: Record<string, string | number | boolean | null>;
  tags: string[];
  handoffs: { reason: string; severity: string; note: string; source: string }[];
  approvals: { action: string; summary: string; status: string }[];
  workflows: {
    id: number;
    name: string;
    status: string;
    last_error: string | null;
    resume_at: string | null;
    steps: { step_no: number; kind: string; outcome: string; detail: string }[];
  }[];
  sequences: { id: number; name: string; status: string }[];
  listen: { id: number; rule_id: number; snippet: string }[];
  notifications: { kind: string; severity: string; title: string }[];
  other_messages: (SandboxReply | { action: string; channel: string })[];
  timeline: { action: string; actor_kind: string; note: string }[];
  blocked: { kind: string; target: string }[];
  usage: { calls: number; tokens: number; failed: number };
  settings: { autonomy: string; effective: string; force_auto: boolean };
  saved: false;
  duration_ms: number;
  verdict?: { pass: boolean; checks: SandboxCheck[] };
};

const SANDBOX = "api/v1/portal/sandbox";
/** A run is one real pass of the automations (AI calls included); the run
 * routes allow 60 s (maxDuration), so stay just under it. */
const SANDBOX_TIMEOUT_MS = 55_000;

/** portalService, but keeps the Control Plane's own 503 reason when it
 * carries ``keepCode`` (e.g. the database refused the sandbox's temporary
 * safety table, or the AI engine did not answer) instead of a generic one. */
async function reasonService<T>(
  accessToken: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  keepCode: string
): Promise<ServiceResult<T>> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path, init, timeoutMs);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 503) {
    const payload = (await response.clone().json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    const code = payload?.error?.code;
    const message = payload?.error?.message;
    if (code === keepCode && typeof message === "string") {
      return { kind: "invalid", status: 503, code, message };
    }
  }
  return serviceResult<T>(response);
}

function sandboxService<T>(
  accessToken: string,
  path: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<ServiceResult<T>> {
  return reasonService<T>(accessToken, path, init, timeoutMs, "sandbox_unavailable");
}

export function getSandbox(accessToken: string) {
  return sandboxService<SandboxOverview>(accessToken, SANDBOX, { method: "GET" });
}

export function runSandbox(accessToken: string, input: SandboxInput) {
  return sandboxService<SandboxResult>(accessToken, SANDBOX + "/run", {
    method: "POST",
    body: JSON.stringify(input),
  }, SANDBOX_TIMEOUT_MS);
}

export function createSandboxScenario(accessToken: string, input: SandboxScenarioInput) {
  return sandboxService<{ scenario: SandboxScenario }>(accessToken, SANDBOX + "/scenarios", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSandboxScenario(
  accessToken: string,
  scenarioId: number,
  input: SandboxScenarioInput
) {
  return sandboxService<{ scenario: SandboxScenario }>(
    accessToken, SANDBOX + "/scenarios/" + scenarioId, {
      method: "PUT",
      body: JSON.stringify(input),
    });
}

export function deleteSandboxScenario(accessToken: string, scenarioId: number) {
  return sandboxService<{ ok: boolean }>(
    accessToken, SANDBOX + "/scenarios/" + scenarioId, { method: "DELETE" });
}

export function runSandboxScenario(accessToken: string, scenarioId: number) {
  return sandboxService<SandboxResult>(
    accessToken, SANDBOX + "/scenarios/" + scenarioId + "/run", {
      method: "POST",
      body: "{}",
    }, SANDBOX_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// §231 NL Workflow Generator: describe an automation in plain words and get
// a draft for the builder. The Control Plane saves nothing; the owner opens
// the draft in the builder, creates it as a draft and activates it there.
// ---------------------------------------------------------------------------

export interface WorkflowGenReviewItem {
  level: "info" | "warn" | "high";
  text: string;
}

export interface WorkflowGenStatus {
  enabled: boolean;
  ready: boolean;
  reason: string;
  limits: { maxDescription: number; maxInstruction: number; perHour: number; maxSteps: number };
}

export interface WorkflowGenInput {
  description: string;
  instruction: string;
  current: WorkflowUpsert | null;
}

export interface WorkflowGenResult {
  workflow: WorkflowTemplate;
  review: WorkflowGenReviewItem[];
  assumptions: string[];
  questions: string[];
  unsupported: string[];
  attempts: number;
}

const WORKFLOW_GEN = "api/v1/portal/workflows/generate";
/** One or two model calls; the route allows 60 s (maxDuration). */
const WORKFLOW_GEN_TIMEOUT_MS = 55_000;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function getWorkflowGenerator(
  accessToken: string
): Promise<ServiceResult<WorkflowGenStatus>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, WORKFLOW_GEN, { method: "GET" }, REQUEST_TIMEOUT_MS, "ai_unavailable");
  if (result.kind !== "ok") return result;
  const row = result.data;
  const limits = asRecord(row.limits);
  return {
    kind: "ok",
    data: {
      enabled: row.enabled === true,
      ready: row.ready === true,
      reason: typeof row.reason === "string" ? row.reason : "",
      limits: {
        maxDescription: numberOr(limits.max_description, 1000),
        maxInstruction: numberOr(limits.max_instruction, 500),
        perHour: numberOr(limits.per_hour, 20),
        maxSteps: numberOr(limits.max_steps, 12),
      },
    },
  };
}

export async function generateWorkflow(
  accessToken: string,
  input: WorkflowGenInput
): Promise<ServiceResult<WorkflowGenResult>> {
  const body: Record<string, unknown> = {
    description: input.description,
    instruction: input.instruction,
  };
  if (input.current) body.current = JSON.parse(workflowBody(input.current));
  const result = await reasonService<Record<string, unknown>>(
    accessToken, WORKFLOW_GEN, { method: "POST", body: JSON.stringify(body) },
    WORKFLOW_GEN_TIMEOUT_MS, "ai_unavailable");
  if (result.kind !== "ok") return result;
  const row = result.data;
  const review = (Array.isArray(row.review) ? row.review : [])
    .map((item) => {
      const r = asRecord(item);
      const level = r.level === "warn" || r.level === "high" ? r.level : "info";
      return { level, text: typeof r.text === "string" ? r.text : "" } as WorkflowGenReviewItem;
    })
    .filter((item) => item.text !== "");
  return {
    kind: "ok",
    data: {
      workflow: { ...normalizeWorkflowTemplate(row.workflow), key: "generated" },
      review,
      assumptions: stringList(row.assumptions),
      questions: stringList(row.questions),
      unsupported: stringList(row.unsupported),
      attempts: numberOr(row.attempts, 1),
    },
  };
}

// ---------------------------------------------------------------------------
// §232 Rule Conflict Detector
// ---------------------------------------------------------------------------

export type RuleConflictSeverity = "high" | "warn" | "info";

export interface RuleConflictRef {
  type: string;
  id: string;
  label: string;
  href: string;
}

export interface RuleConflict {
  id: string;
  code: string;
  severity: RuleConflictSeverity;
  title: string;
  detail: string;
  fix: string;
  rules: RuleConflictRef[];
  ignored: boolean;
}

export interface RuleConflictReport {
  findings: RuleConflict[];
  counts: { high: number; warn: number; info: number; ignored: number };
  checked: { routing: number; workflows: number; sequences: number; kb: number; facts: number };
  ai: {
    ready: boolean;
    reason: string;
    candidates: number;
    pairsPerCheck: number;
    checkedAt: string;
    checkedPairs: number;
  };
}

export interface RuleConflictAiResult {
  checkedPairs: number;
  remainingPairs: number;
  findings: RuleConflict[];
}

const RULE_CONFLICTS = "api/v1/portal/policy/conflicts";
/** One model call; the route allows 60 s (maxDuration). */
const RULE_CONFLICTS_AI_TIMEOUT_MS = 50_000;

function ruleConflict(value: unknown): RuleConflict {
  const row = asRecord(value);
  const severity = row.severity === "high" || row.severity === "warn" ? row.severity : "info";
  return {
    id: typeof row.id === "string" ? row.id : "",
    code: typeof row.code === "string" ? row.code : "",
    severity,
    title: typeof row.title === "string" ? row.title : "",
    detail: typeof row.detail === "string" ? row.detail : "",
    fix: typeof row.fix === "string" ? row.fix : "",
    ignored: row.ignored === true,
    rules: (Array.isArray(row.rules) ? row.rules : []).map((item) => {
      const ref = asRecord(item);
      const href = typeof ref.href === "string" && ref.href.startsWith("/dashboard/")
        ? ref.href : "/dashboard/rules";
      return {
        type: typeof ref.type === "string" ? ref.type : "",
        id: String(ref.id ?? ""),
        label: typeof ref.label === "string" ? ref.label : "",
        href,
      };
    }),
  };
}

export async function getRuleConflicts(
  accessToken: string
): Promise<ServiceResult<RuleConflictReport>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, RULE_CONFLICTS, { method: "GET" }, REQUEST_TIMEOUT_MS, "ai_unavailable");
  if (result.kind !== "ok") return result;
  const row = result.data;
  const counts = asRecord(row.counts);
  const checked = asRecord(row.checked);
  const ai = asRecord(row.ai);
  return {
    kind: "ok",
    data: {
      findings: (Array.isArray(row.findings) ? row.findings : []).map(ruleConflict)
        .filter((item) => item.id !== ""),
      counts: {
        high: numberOr(counts.high, 0), warn: numberOr(counts.warn, 0),
        info: numberOr(counts.info, 0), ignored: numberOr(counts.ignored, 0),
      },
      checked: {
        routing: numberOr(checked.routing, 0), workflows: numberOr(checked.workflows, 0),
        sequences: numberOr(checked.sequences, 0), kb: numberOr(checked.kb, 0),
        facts: numberOr(checked.facts, 0),
      },
      ai: {
        ready: ai.ready === true,
        reason: typeof ai.reason === "string" ? ai.reason : "",
        candidates: numberOr(ai.candidates, 0),
        pairsPerCheck: numberOr(ai.pairs_per_check, 8),
        checkedAt: typeof ai.checked_at === "string" ? ai.checked_at : "",
        checkedPairs: numberOr(ai.checked_pairs, 0),
      },
    },
  };
}

export async function setRuleConflictIgnored(
  accessToken: string,
  id: string,
  ignored: boolean
): Promise<ServiceResult<{ id: string; ignored: boolean }>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, RULE_CONFLICTS + "/ignore",
    { method: "POST", body: JSON.stringify({ id, ignored }) },
    REQUEST_TIMEOUT_MS, "portal_unavailable");
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: { id: String(result.data.id ?? id), ignored: result.data.ignored === true } };
}

export async function checkRuleConflictsWithAi(
  accessToken: string
): Promise<ServiceResult<RuleConflictAiResult>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, RULE_CONFLICTS + "/ai-check", { method: "POST", body: "{}" },
    RULE_CONFLICTS_AI_TIMEOUT_MS, "ai_unavailable");
  if (result.kind !== "ok") return result;
  const row = result.data;
  return {
    kind: "ok",
    data: {
      checkedPairs: numberOr(row.checked_pairs, 0),
      remainingPairs: numberOr(row.remaining_pairs, 0),
      findings: (Array.isArray(row.findings) ? row.findings : []).map(ruleConflict),
    },
  };
}

// ---------------------------------------------------------------------------
// §233 Ask your data (NL analytics)
// ---------------------------------------------------------------------------

export type NlUnit = "count" | "money" | "percent" | "score";

export interface NlPlan {
  metric: string;
  period: string;
  compare: "previous" | "none";
  groupBy: string;
  filters: Record<string, string>;
  limit: number;
}

export interface NlMetric {
  key: string;
  label: string;
  category: string;
  unit: NlUnit;
  dims: { key: string; label: string }[];
}

export interface NlCatalog {
  metrics: NlMetric[];
  periods: { key: string; label: string }[];
  suggestions: string[];
  currency: string;
  ai: { ready: boolean; reason: string };
  canPin: boolean;
  maxPins: number;
}

export interface NlPoint {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
}

export interface NlAnswer {
  metric: string;
  label: string;
  unit: NlUnit;
  currency: string;
  goodDirection: "up" | "down";
  periodLabel: string;
  periodRange: string;
  previousLabel: string;
  previousRange: string;
  value: number | null;
  previous: number | null;
  changePct: number | null;
  changePoints: number | null;
  groupBy: string;
  groupLabel: string;
  chart: "time" | "rank" | "none";
  series: NlPoint[];
  others: number | null;
  headline: string;
  how: string[];
  plan: NlPlan;
  empty: boolean;
}

export interface NlAskResult {
  answer: NlAnswer | null;
  source: string;
  message: string;
  suggestions: string[];
}

export interface NlPin {
  id: number;
  question: string;
  answer: NlAnswer | null;
  error: string;
}

const NL_ANALYTICS = "api/v1/portal/analytics";
/** One small model call to read the question; the route allows 30 s. */
const NL_ANALYTICS_ASK_TIMEOUT_MS = 25_000;

function nlNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nlText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nlUnit(value: unknown): NlUnit {
  return value === "money" || value === "percent" || value === "score" ? value : "count";
}

function nlPlan(value: unknown): NlPlan {
  const row = asRecord(value);
  const filters: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(row.filters))) {
    if (typeof item === "string") filters[key] = item;
  }
  return {
    metric: nlText(row.metric),
    period: nlText(row.period) || "last_30_days",
    compare: row.compare === "previous" ? "previous" : "none",
    groupBy: nlText(row.group_by) || "none",
    filters,
    limit: numberOr(row.limit, 10),
  };
}

/** Wire shape the Control Plane validates (snake_case keys). */
export function nlPlanToWire(plan: NlPlan): Record<string, unknown> {
  return {
    metric: plan.metric,
    period: plan.period,
    compare: plan.compare,
    group_by: plan.groupBy,
    filters: plan.filters,
    limit: plan.limit,
  };
}

function nlRange(value: unknown): string {
  const row = asRecord(value);
  const start = nlText(row.start);
  const end = nlText(row.end);
  return start && end ? (start === end ? start : start + " – " + end) : "";
}

function nlAnswer(value: unknown): NlAnswer | null {
  const row = asRecord(value);
  if (!row.metric || typeof row.headline !== "string") return null;
  const period = asRecord(row.period);
  const previous = asRecord(row.previous_period);
  const chart = row.chart === "time" || row.chart === "rank" ? row.chart : "none";
  return {
    metric: nlText(row.metric),
    label: nlText(row.label),
    unit: nlUnit(row.unit),
    currency: nlText(row.currency),
    goodDirection: row.good_direction === "down" ? "down" : "up",
    periodLabel: nlText(period.label),
    periodRange: nlRange(period),
    previousLabel: nlText(previous.label),
    previousRange: nlRange(previous),
    value: nlNumber(row.value),
    previous: nlNumber(row.previous),
    changePct: nlNumber(row.change_pct),
    changePoints: nlNumber(row.change_points),
    groupBy: nlText(row.group_by) || "none",
    groupLabel: nlText(row.group_label),
    chart,
    series: (Array.isArray(row.series) ? row.series : []).map((item) => {
      const point = asRecord(item);
      return {
        key: String(point.key ?? ""),
        label: nlText(point.label),
        value: nlNumber(point.value),
        previous: nlNumber(point.previous),
      };
    }),
    others: nlNumber(row.others),
    headline: row.headline,
    how: (Array.isArray(row.how) ? row.how : []).filter(
      (item): item is string => typeof item === "string"
    ),
    plan: nlPlan(row.plan),
    empty: row.empty === true,
  };
}

export async function getAnalyticsCatalog(
  accessToken: string
): Promise<ServiceResult<NlCatalog>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, NL_ANALYTICS + "/ask", { method: "GET" }, REQUEST_TIMEOUT_MS,
    "portal_unavailable");
  if (result.kind !== "ok") return result;
  const row = result.data;
  const ai = asRecord(row.ai);
  return {
    kind: "ok",
    data: {
      metrics: (Array.isArray(row.metrics) ? row.metrics : []).map((item) => {
        const metric = asRecord(item);
        return {
          key: nlText(metric.key),
          label: nlText(metric.label),
          category: nlText(metric.category),
          unit: nlUnit(metric.unit),
          dims: (Array.isArray(metric.dims) ? metric.dims : []).map((dim) => {
            const entry = asRecord(dim);
            return { key: nlText(entry.key), label: nlText(entry.label) };
          }),
        };
      }).filter((metric) => metric.key !== ""),
      periods: (Array.isArray(row.periods) ? row.periods : []).map((item) => {
        const entry = asRecord(item);
        return { key: nlText(entry.key), label: nlText(entry.label) };
      }),
      suggestions: (Array.isArray(row.suggestions) ? row.suggestions : []).filter(
        (item): item is string => typeof item === "string"
      ),
      currency: nlText(row.currency),
      ai: { ready: ai.ready === true, reason: nlText(ai.reason) },
      canPin: row.can_pin === true,
      maxPins: numberOr(row.max_pins, 12),
    },
  };
}

export async function askAnalytics(
  accessToken: string,
  input: { question?: string; plan?: NlPlan }
): Promise<ServiceResult<NlAskResult>> {
  const body: Record<string, unknown> = {};
  if (input.question) body.question = input.question;
  if (input.plan) body.plan = nlPlanToWire(input.plan);
  const result = await reasonService<Record<string, unknown>>(
    accessToken, NL_ANALYTICS + "/ask",
    { method: "POST", body: JSON.stringify(body) },
    NL_ANALYTICS_ASK_TIMEOUT_MS, "portal_unavailable");
  if (result.kind !== "ok") return result;
  const row = result.data;
  return {
    kind: "ok",
    data: {
      answer: nlAnswer(row.answer),
      source: nlText(row.source),
      message: nlText(row.message),
      suggestions: (Array.isArray(row.suggestions) ? row.suggestions : []).filter(
        (item): item is string => typeof item === "string"
      ),
    },
  };
}

export async function getAnalyticsPins(
  accessToken: string
): Promise<ServiceResult<{ pins: NlPin[]; maxPins: number; canPin: boolean }>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, NL_ANALYTICS + "/pins", { method: "GET" }, REQUEST_TIMEOUT_MS,
    "portal_unavailable");
  if (result.kind !== "ok") return result;
  const row = result.data;
  return {
    kind: "ok",
    data: {
      pins: (Array.isArray(row.pins) ? row.pins : []).map((item) => {
        const pin = asRecord(item);
        return {
          id: numberOr(pin.id, 0),
          question: nlText(pin.question),
          answer: nlAnswer(pin.answer),
          error: nlText(pin.error),
        };
      }).filter((pin) => pin.id > 0),
      maxPins: numberOr(row.max_pins, 12),
      canPin: row.can_pin === true,
    },
  };
}

export async function pinAnalyticsQuestion(
  accessToken: string,
  question: string,
  plan: NlPlan
): Promise<ServiceResult<{ id: number; duplicate: boolean }>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, NL_ANALYTICS + "/pins",
    { method: "POST", body: JSON.stringify({ question, plan: nlPlanToWire(plan) }) },
    REQUEST_TIMEOUT_MS, "portal_unavailable");
  if (result.kind !== "ok") return result;
  return {
    kind: "ok",
    data: {
      id: numberOr(asRecord(result.data.pin).id, 0),
      duplicate: result.data.duplicate === true,
    },
  };
}

export async function unpinAnalyticsQuestion(
  accessToken: string,
  id: number
): Promise<ServiceResult<{ deleted: boolean }>> {
  const result = await reasonService<Record<string, unknown>>(
    accessToken, NL_ANALYTICS + "/pins/" + String(id), { method: "DELETE" },
    REQUEST_TIMEOUT_MS, "portal_unavailable");
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: { deleted: result.data.deleted === true } };
}

// ---------------------------------------------------------------------------
// §234 Broadcast A/B tests
// ---------------------------------------------------------------------------

export type AbMetric = "reply" | "order";

export interface AbInput {
  name: string;
  audience: string;
  variants: string[];
  testPercent: number;
  decideHours: number;
  metric: AbMetric;
  autoWinner: boolean;
}

export interface AbVariant {
  label: string;
  body: string;
  sent: number;
  delivered: number;
  failed: number;
  replied: number;
  ordered: number;
  sales: number;
  replyRate: number | null;
  orderRate: number | null;
}

export interface AbDecision {
  winner: string | null;
  leader: string | null;
  confidence: number | null;
  clear: boolean;
  reason: string;
}

export interface AbTest {
  id: number;
  name: string;
  audience: string;
  metric: AbMetric;
  testPercent: number;
  decideHours: number;
  autoWinner: boolean;
  autoPending: boolean;
  autoNote: string;
  status: "running" | "completed" | "cancelled";
  windowOver: boolean;
  audienceSize: number;
  testSize: number;
  restSize: number;
  restSent: number;
  winner: string | null;
  winnerReason: string | null;
  createdAt: string | null;
  decideAt: string | null;
  variants: AbVariant[];
  decision: AbDecision;
}

export interface AbConfig {
  currency: string;
  maxVariants: number;
  minPerVariant: number;
  confidence: number;
  defaultPercent: number;
  defaultHours: number;
  maxRecipients: number;
  maxBody: number;
  metrics: { key: AbMetric; label: string }[];
  audiences: { key: string; label: string }[];
}

export interface AbPlan {
  audienceSize: number;
  testSize: number;
  perVariant: number;
  restSize: number;
  autoWinner: boolean;
  warnings: string[];
}

const AB_TESTS = "api/v1/portal/ab-tests";
/** Starting a test / sending the winner queues up to 200 sends; routes allow 30 s. */
const AB_SEND_TIMEOUT_MS = 25_000;

function abText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function abRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function abMetric(value: unknown): AbMetric {
  return value === "order" ? "order" : "reply";
}

function abVariant(value: unknown): AbVariant {
  const row = asRecord(value);
  return {
    label: abText(row.label),
    body: abText(row.body),
    sent: numberOr(row.sent, 0),
    delivered: numberOr(row.delivered, 0),
    failed: numberOr(row.failed, 0),
    replied: numberOr(row.replied, 0),
    ordered: numberOr(row.ordered, 0),
    sales: numberOr(row.sales, 0),
    replyRate: abRate(row.reply_rate),
    orderRate: abRate(row.order_rate),
  };
}

function abTest(value: unknown): AbTest {
  const row = asRecord(value);
  const decision = asRecord(row.decision);
  const status = row.status === "completed" || row.status === "cancelled" ? row.status : "running";
  return {
    id: numberOr(row.id, 0),
    name: abText(row.name),
    audience: abText(row.audience),
    metric: abMetric(row.metric),
    testPercent: numberOr(row.test_percent, 0),
    decideHours: numberOr(row.decide_hours, 0),
    autoWinner: row.auto_winner === true,
    autoPending: row.auto_pending === true,
    autoNote: abText(row.auto_note),
    status,
    windowOver: row.window_over === true,
    audienceSize: numberOr(row.audience_size, 0),
    testSize: numberOr(row.test_size, 0),
    restSize: numberOr(row.rest_size, 0),
    restSent: numberOr(row.rest_sent, 0),
    winner: abText(row.winner) || null,
    winnerReason: abText(row.winner_reason) || null,
    createdAt: abText(row.created_at) || null,
    decideAt: abText(row.decide_at) || null,
    variants: (Array.isArray(row.variants) ? row.variants : []).map(abVariant),
    decision: {
      winner: abText(decision.winner) || null,
      leader: abText(decision.leader) || null,
      confidence: abRate(decision.confidence),
      clear: decision.clear === true,
      reason: abText(decision.reason),
    },
  };
}

function abConfig(value: unknown): AbConfig {
  const row = asRecord(value);
  const pairs = (list: unknown) =>
    (Array.isArray(list) ? list : []).map((item) => {
      const entry = asRecord(item);
      return { key: abText(entry.key), label: abText(entry.label) };
    }).filter((entry) => entry.key);
  return {
    currency: abText(row.currency) || "Rs",
    maxVariants: numberOr(row.max_variants, 3),
    minPerVariant: numberOr(row.min_per_variant, 20),
    confidence: numberOr(row.confidence, 95),
    defaultPercent: numberOr(row.default_percent, 30),
    defaultHours: numberOr(row.default_hours, 24),
    maxRecipients: numberOr(row.max_recipients, 200),
    maxBody: numberOr(row.max_body, 1000),
    metrics: pairs(row.metrics).map((m) => ({ key: abMetric(m.key), label: m.label })),
    audiences: pairs(row.audiences),
  };
}

export async function listAbTests(
  accessToken: string
): Promise<ServiceResult<{ tests: AbTest[]; config: AbConfig }>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AB_TESTS, { method: "GET" });
  if (result.kind !== "ok") return result;
  return {
    kind: "ok",
    data: {
      tests: (Array.isArray(result.data.tests) ? result.data.tests : [])
        .map(abTest).filter((test) => test.id > 0),
      config: abConfig(result.data.config),
    },
  };
}

/** Start a test; ``dryRun`` only returns the split plan (nothing is sent). */
export async function startAbTest(
  accessToken: string,
  input: AbInput,
  dryRun: boolean
): Promise<ServiceResult<{ id: number; plan: AbPlan }>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AB_TESTS, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        audience: input.audience,
        variants: input.variants,
        test_percent: input.testPercent,
        decide_hours: input.decideHours,
        metric: input.metric,
        auto_winner: input.autoWinner,
        dry_run: dryRun,
      }),
    }, AB_SEND_TIMEOUT_MS);
  if (result.kind !== "ok") return result;
  const plan = asRecord(result.data.plan);
  return {
    kind: "ok",
    data: {
      id: numberOr(result.data.id, 0),
      plan: {
        audienceSize: numberOr(plan.audience_size, 0),
        testSize: numberOr(plan.test_size, 0),
        perVariant: numberOr(plan.per_variant, 0),
        restSize: numberOr(plan.rest_size, 0),
        autoWinner: plan.auto_winner === true,
        warnings: (Array.isArray(plan.warnings) ? plan.warnings : [])
          .filter((w): w is string => typeof w === "string"),
      },
    },
  };
}

export async function chooseAbWinner(
  accessToken: string,
  id: number,
  variant: string
): Promise<ServiceResult<{ winner: string; sent: number }>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AB_TESTS + "/" + String(id) + "/winner",
    { method: "POST", body: JSON.stringify({ variant }) }, AB_SEND_TIMEOUT_MS);
  if (result.kind !== "ok") return result;
  return {
    kind: "ok",
    data: { winner: abText(result.data.winner), sent: numberOr(result.data.sent, 0) },
  };
}

export async function cancelAbTest(
  accessToken: string,
  id: number
): Promise<ServiceResult<{ ok: boolean }>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AB_TESTS + "/" + String(id) + "/cancel", { method: "POST" });
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: { ok: result.data.ok === true } };
}

// ---------------------------------------------------------------------------
// §235 AI setup report: score, problems with fixes, what changed since the
// last check, an optional AI summary and the readable setup document.
// ---------------------------------------------------------------------------

export type AiReportSeverity = "critical" | "warning" | "info";

export interface AiReportFinding {
  key: string;
  area: string;
  severity: AiReportSeverity;
  title: string;
  detail: string;
  fixLabel: string;
  fixHref: string;
}

export interface AiReportItem {
  key: string;
  area: string;
  title: string;
}

export interface AiReport {
  id: number;
  score: number;
  counts: Record<AiReportSeverity, number>;
  findings: AiReportFinding[];
  passes: AiReportItem[];
  skipped: AiReportItem[];
  priorities: string[];
  summary: string;
  summarySource: "ai" | "rules";
  origin: "owner" | "auto" | "summary";
  createdAt: string | null;
}

export interface AiReportChanges {
  scoreBefore: number;
  scoreChange: number;
  added: { key: string; title: string; severity: AiReportSeverity }[];
  resolved: { key: string; title: string }[];
  since: string | null;
}

export interface AiReportView {
  report: AiReport;
  changes: AiReportChanges | null;
  config: {
    canSummarize: boolean;
    aiReady: boolean;
    aiReason: string;
    everyHours: number;
    freshMinutes: number;
    areas: { key: string; label: string }[];
  };
  note: string;
}

export interface AiSetupSection {
  key: string;
  title: string;
  href: string;
  rows: { label: string; value: string }[];
  items: { title: string; tag: string; body: string; meta: string }[];
}

export interface AiSetupDocument {
  sections: AiSetupSection[];
  generatedAt: string | null;
}

const AI_REPORT = "api/v1/portal/ai-report";
/** A check reads ~30 small queries; the summary adds one model call (20 s cap). */
const AI_REPORT_TIMEOUT_MS = 25_000;

function airText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function airSeverity(value: unknown): AiReportSeverity {
  return value === "critical" || value === "warning" ? value : "info";
}

function airItem(value: unknown): AiReportItem {
  const row = asRecord(value);
  return { key: airText(row.key), area: airText(row.area), title: airText(row.title) };
}

function airView(value: Record<string, unknown>): AiReportView {
  const report = asRecord(value.report);
  const counts = asRecord(report.counts);
  const config = asRecord(value.config);
  const changes = value.changes ? asRecord(value.changes) : null;
  const list = (raw: unknown) => (Array.isArray(raw) ? raw : []);
  return {
    report: {
      id: numberOr(report.id, 0),
      score: numberOr(report.score, 0),
      counts: {
        critical: numberOr(counts.critical, 0),
        warning: numberOr(counts.warning, 0),
        info: numberOr(counts.info, 0),
      },
      findings: list(report.findings).map((raw) => {
        const row = asRecord(raw);
        return {
          ...airItem(row),
          severity: airSeverity(row.severity),
          detail: airText(row.detail),
          fixLabel: airText(row.fix_label),
          fixHref: airText(row.fix_href).startsWith("/dashboard/") ? airText(row.fix_href) : "",
        };
      }),
      passes: list(report.passes).map(airItem),
      skipped: list(report.skipped).map(airItem),
      priorities: list(report.priorities).filter((k): k is string => typeof k === "string"),
      summary: airText(report.summary),
      summarySource: report.summary_source === "ai" ? "ai" : "rules",
      origin: report.origin === "auto" || report.origin === "summary" ? report.origin : "owner",
      createdAt: airText(report.created_at) || null,
    },
    changes: changes
      ? {
          scoreBefore: numberOr(changes.score_before, 0),
          scoreChange: numberOr(changes.score_change, 0),
          added: list(changes.new).map((raw) => {
            const row = asRecord(raw);
            return { key: airText(row.key), title: airText(row.title), severity: airSeverity(row.severity) };
          }),
          resolved: list(changes.resolved).map((raw) => {
            const row = asRecord(raw);
            return { key: airText(row.key), title: airText(row.title) };
          }),
          since: airText(changes.since) || null,
        }
      : null,
    config: {
      canSummarize: config.can_summarize === true,
      aiReady: config.ai_ready === true,
      aiReason: airText(config.ai_reason),
      everyHours: numberOr(config.every_hours, 24),
      freshMinutes: numberOr(config.fresh_minutes, 10),
      areas: list(config.areas).map((raw) => {
        const row = asRecord(raw);
        return { key: airText(row.key), label: airText(row.label) };
      }),
    },
    note: airText(value.note),
  };
}

/** The latest report; ``fresh`` re-checks now (limited per hour). */
export async function getAiReport(
  accessToken: string,
  fresh = false
): Promise<ServiceResult<AiReportView>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AI_REPORT + (fresh ? "?fresh=1" : ""), { method: "GET" }, AI_REPORT_TIMEOUT_MS);
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: airView(result.data) };
}

/** Fresh check + AI summary (owner / admin; daily limit). */
export async function summarizeAiReport(
  accessToken: string
): Promise<ServiceResult<AiReportView>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AI_REPORT + "/summary", { method: "POST" }, AI_REPORT_TIMEOUT_MS);
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: airView(result.data) };
}

export async function getAiSetupDocument(
  accessToken: string
): Promise<ServiceResult<AiSetupDocument>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AI_REPORT + "/document", { method: "GET" }, AI_REPORT_TIMEOUT_MS);
  if (result.kind !== "ok") return result;
  const list = (raw: unknown) => (Array.isArray(raw) ? raw : []);
  return {
    kind: "ok",
    data: {
      sections: list(result.data.sections).map((raw) => {
        const row = asRecord(raw);
        return {
          key: airText(row.key),
          title: airText(row.title),
          href: airText(row.href).startsWith("/dashboard/") ? airText(row.href) : "",
          rows: list(row.rows).map((item) => {
            const r = asRecord(item);
            return { label: airText(r.label), value: airText(r.value) };
          }),
          items: list(row.items).map((item) => {
            const r = asRecord(item);
            return { title: airText(r.title), tag: airText(r.tag), body: airText(r.body), meta: airText(r.meta) };
          }),
        };
      }),
      generatedAt: airText(result.data.generated_at) || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Handoff brief (§236): what a teammate needs before taking over a chat.
// ---------------------------------------------------------------------------

export interface HandoffBrief {
  conversationId: number;
  customer: { name: string; channel: string };
  headline: string;
  handoff: {
    id: number;
    reasonLabel: string;
    severity: string;
    note: string;
    status: string;
    hits: number;
    createdAt: string | null;
  } | null;
  asked: { text: string; at: string | null }[];
  lastReply: { text: string; by: string; at: string | null } | null;
  waitingMinutes: number | null;
  aiReason: { decision: string; reason: string; confidence: number | null } | null;
  signals: Record<"intent" | "sentiment" | "language" | "purchase_intent" | "urgency", string> | null;
  facts: { kind: string; text: string }[];
  orders: { id: number; title: string; total: number | null; paid: number | null; status: string }[];
  cod: { id: number; status: string }[];
  series: { id: number; name: string; status: string; nextAt: string | null }[];
  nextSteps: string[];
  ai: { summary: string; nextStep: string; createdAt: string | null; stale: boolean } | null;
}

export interface HandoffBriefView {
  brief: HandoffBrief;
  aiReady: boolean;
  aiReason: string;
  note: string;
  cached: boolean;
}

const BRIEF_TIMEOUT_MS = 25_000;

function briefText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function briefNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function briefList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : [];
}

function briefView(value: Record<string, unknown>): HandoffBriefView {
  const raw = asRecord(value.brief);
  const handoff = raw.handoff ? asRecord(raw.handoff) : null;
  const reply = raw.last_reply ? asRecord(raw.last_reply) : null;
  const trace = raw.ai_reason ? asRecord(raw.ai_reason) : null;
  const signals = raw.signals ? asRecord(raw.signals) : null;
  const ai = raw.ai ? asRecord(raw.ai) : null;
  const customer = asRecord(raw.customer);
  return {
    brief: {
      conversationId: briefNumber(raw.conversation_id) ?? 0,
      customer: { name: briefText(customer.name), channel: briefText(customer.channel) },
      headline: briefText(raw.headline),
      handoff: handoff
        ? {
            id: briefNumber(handoff.id) ?? 0,
            reasonLabel: briefText(handoff.reason_label),
            severity: briefText(handoff.severity),
            note: briefText(handoff.note),
            status: briefText(handoff.status),
            hits: briefNumber(handoff.hits) ?? 1,
            createdAt: briefText(handoff.created_at) || null,
          }
        : null,
      asked: briefList(raw.asked).map((row) => ({
        text: briefText(row.text),
        at: briefText(row.at) || null,
      })),
      lastReply: reply
        ? { text: briefText(reply.text), by: briefText(reply.by), at: briefText(reply.at) || null }
        : null,
      waitingMinutes: briefNumber(raw.waiting_minutes),
      aiReason: trace
        ? {
            decision: briefText(trace.decision),
            reason: briefText(trace.reason),
            confidence: briefNumber(trace.confidence),
          }
        : null,
      signals: signals
        ? {
            intent: briefText(signals.intent),
            sentiment: briefText(signals.sentiment),
            language: briefText(signals.language),
            purchase_intent: briefText(signals.purchase_intent),
            urgency: briefText(signals.urgency),
          }
        : null,
      facts: briefList(raw.facts).map((row) => ({ kind: briefText(row.kind), text: briefText(row.text) })),
      orders: briefList(raw.orders).map((row) => ({
        id: briefNumber(row.id) ?? 0,
        title: briefText(row.title),
        total: briefNumber(row.total),
        paid: briefNumber(row.paid),
        status: briefText(row.status),
      })),
      cod: briefList(raw.cod).map((row) => ({ id: briefNumber(row.id) ?? 0, status: briefText(row.status) })),
      series: briefList(raw.series).map((row) => ({
        id: briefNumber(row.id) ?? 0,
        name: briefText(row.name),
        status: briefText(row.status),
        nextAt: briefText(row.next_at) || null,
      })),
      nextSteps: (Array.isArray(raw.next_steps) ? raw.next_steps : []).filter(
        (item): item is string => typeof item === "string"
      ),
      ai: ai
        ? {
            summary: briefText(ai.summary),
            nextStep: briefText(ai.next_step),
            createdAt: briefText(ai.created_at) || null,
            stale: ai.stale === true,
          }
        : null,
    },
    aiReady: value.ai_ready === true,
    aiReason: briefText(value.ai_reason),
    note: briefText(value.note),
    cached: value.cached === true,
  };
}

async function briefCall(
  accessToken: string,
  path: string,
  method: "GET" | "POST"
): Promise<ServiceResult<HandoffBriefView>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, path, method === "POST" ? { method, body: "{}" } : { method }, BRIEF_TIMEOUT_MS);
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: briefView(result.data) };
}

export function getHandoffBrief(accessToken: string, conversationId: number) {
  return briefCall(
    accessToken, "api/v1/portal/conversations/" + conversationId + "/handoff-brief", "GET");
}

export function getEscalationBrief(accessToken: string, escalationId: number) {
  return briefCall(accessToken, "api/v1/portal/escalations/" + escalationId + "/brief", "GET");
}

/** Optional AI-written brief (cached per last message; daily cap per workspace). */
export function requestAiHandoffBrief(accessToken: string, conversationId: number) {
  return briefCall(
    accessToken, "api/v1/portal/conversations/" + conversationId + "/handoff-brief/ai", "POST");
}

// ---------------------------------------------------------------------------
// Sales agent (§237): qualify, concerns + approved answers, catalog quotes.
// ---------------------------------------------------------------------------

export type SalesQualifier = "product" | "quantity" | "city" | "budget" | "timeline" | "payment";

export interface SalesSettings {
  autoStage: boolean;
  brainContext: boolean;
  qualifiers: SalesQualifier[];
}

export interface SalesPlaybookEntry {
  kind: string;
  label: string;
  reply: string;
  enabled: boolean;
  suggestion: string;
}

export interface SalesSettingsView {
  settings: SalesSettings;
  playbook: SalesPlaybookEntry[];
  qualifiers: { key: SalesQualifier; label: string }[];
  canEdit: boolean;
}

export interface SalesLead {
  conversationId: number;
  contactName: string;
  score: number;
  label: "hot" | "warm" | "cold";
  stageHint: string;
  purchaseIntent: string;
  known: { key: string; label: string; value: string }[];
  missing: { key: string; label: string }[];
  askNext: string;
  concerns: {
    kind: string;
    label: string;
    count: number;
    current: boolean;
    approvedAnswer: string;
    suggestion: string;
  }[];
  products: { id: number; name: string; price: number | null; stock: number }[];
  quotes: { id: number; title: string; total: number; status: string; token: string }[];
  bought: boolean;
}

export interface SalesLeadView {
  lead: SalesLead;
  catalog: { id: number; name: string; price: number; stock: number }[];
  maxDiscountPercent: number;
  canDiscount: boolean;
  quoteDays: number;
}

export interface SalesOverview {
  days: number;
  leads: {
    conversationId: number;
    contactName: string;
    score: number;
    label: "hot" | "warm" | "cold";
    stageHint: string;
    product: string;
    concerns: string[];
    bought: boolean;
    updatedAt: string | null;
  }[];
  concerns: { kind: string; label: string; chats: number; bought: number; rate: number; hasAnswer: boolean }[];
  totals: Record<"hot" | "warm" | "cold", { chats: number; bought: number }>;
}

export interface SalesQuoteInput {
  conversationId: number;
  items: { catalogId: number; qty: number }[];
  discountPercent: number;
  /** null -> the workspace default (OF_SALES_QUOTE_DAYS) */
  expiresInDays: number | null;
  title: string;
}

export interface SalesQuote {
  id: number;
  token: string;
  title: string;
  total: number;
  discount: number;
  items: { name: string; qty: number; price: number }[];
  expiresAt: string | null;
}

const SALES = "api/v1/portal/sales";
const SALES_QUALIFIERS: SalesQualifier[] = ["product", "quantity", "city", "budget", "timeline", "payment"];

function salesText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function salesNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function salesRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : [];
}

function salesLabel(value: unknown): "hot" | "warm" | "cold" {
  return value === "hot" || value === "warm" ? value : "cold";
}

function salesQualifiers(value: unknown): SalesQualifier[] {
  return Array.isArray(value)
    ? value.filter((item): item is SalesQualifier => SALES_QUALIFIERS.includes(item as SalesQualifier))
    : [];
}

function salesSettingsView(value: Record<string, unknown>): SalesSettingsView {
  const settings = asRecord(value.settings);
  return {
    settings: {
      autoStage: settings.auto_stage === true,
      brainContext: settings.brain_context !== false,
      qualifiers: salesQualifiers(settings.qualifiers),
    },
    playbook: salesRows(value.playbook).map((row) => ({
      kind: salesText(row.kind),
      label: salesText(row.label),
      reply: salesText(row.reply),
      enabled: row.enabled === true,
      suggestion: salesText(row.suggestion),
    })),
    qualifiers: salesRows(value.qualifiers)
      .filter((row) => SALES_QUALIFIERS.includes(row.key as SalesQualifier))
      .map((row) => ({ key: row.key as SalesQualifier, label: salesText(row.label) })),
    canEdit: value.can_edit === true,
  };
}

export async function getSalesSettings(accessToken: string): Promise<ServiceResult<SalesSettingsView>> {
  const result = await portalService<Record<string, unknown>>(accessToken, SALES + "/settings", { method: "GET" });
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: salesSettingsView(result.data) };
}

export async function saveSalesSettings(
  accessToken: string,
  input: Partial<SalesSettings>
): Promise<ServiceResult<{ settings: SalesSettings }>> {
  const body: Record<string, unknown> = {};
  if (typeof input.autoStage === "boolean") body.auto_stage = input.autoStage;
  if (typeof input.brainContext === "boolean") body.brain_context = input.brainContext;
  if (Array.isArray(input.qualifiers)) body.qualifiers = input.qualifiers;
  const result = await portalService<Record<string, unknown>>(
    accessToken, SALES + "/settings", { method: "PUT", body: JSON.stringify(body) });
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: { settings: salesSettingsView({ settings: result.data.settings }).settings } };
}

export async function saveSalesPlaybook(
  accessToken: string,
  kind: string,
  reply: string,
  enabled: boolean
): Promise<ServiceResult<{ playbook: SalesPlaybookEntry[] }>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, SALES + "/playbook/" + encodeURIComponent(kind),
    { method: "PUT", body: JSON.stringify({ reply, enabled }) });
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: { playbook: salesSettingsView({ playbook: result.data.playbook }).playbook } };
}

export async function getSalesLead(
  accessToken: string,
  conversationId: number
): Promise<ServiceResult<SalesLeadView>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, SALES + "/conversations/" + conversationId, { method: "GET" });
  if (result.kind !== "ok") return result;
  const raw = asRecord(result.data.lead);
  return {
    kind: "ok",
    data: {
      lead: {
        conversationId: salesNumber(raw.conversation_id),
        contactName: salesText(raw.contact_name),
        score: salesNumber(raw.score),
        label: salesLabel(raw.label),
        stageHint: salesText(raw.stage_hint),
        purchaseIntent: salesText(raw.purchase_intent),
        known: salesRows(raw.known).map((row) => ({
          key: salesText(row.key), label: salesText(row.label), value: salesText(row.value),
        })),
        missing: salesRows(raw.missing).map((row) => ({ key: salesText(row.key), label: salesText(row.label) })),
        askNext: salesText(raw.ask_next),
        concerns: salesRows(raw.concerns).map((row) => ({
          kind: salesText(row.kind),
          label: salesText(row.label),
          count: salesNumber(row.count),
          current: row.current === true,
          approvedAnswer: salesText(row.approved_answer),
          suggestion: salesText(row.suggestion),
        })),
        products: salesRows(raw.products).map((row) => ({
          id: salesNumber(row.id),
          name: salesText(row.name),
          price: typeof row.price === "number" ? row.price : null,
          stock: salesNumber(row.stock),
        })),
        quotes: salesRows(raw.quotes).map((row) => ({
          id: salesNumber(row.id),
          title: salesText(row.title),
          total: salesNumber(row.total),
          status: salesText(row.status),
          token: salesText(row.token),
        })),
        bought: raw.bought === true,
      },
      catalog: salesRows(result.data.catalog).map((row) => ({
        id: salesNumber(row.id), name: salesText(row.name), price: salesNumber(row.price), stock: salesNumber(row.stock),
      })),
      maxDiscountPercent: salesNumber(result.data.max_discount_percent),
      canDiscount: result.data.can_discount === true,
      quoteDays: salesNumber(result.data.quote_days),
    },
  };
}

export async function getSalesOverview(accessToken: string): Promise<ServiceResult<SalesOverview>> {
  const result = await portalService<Record<string, unknown>>(accessToken, SALES + "/overview", { method: "GET" });
  if (result.kind !== "ok") return result;
  const totals = asRecord(result.data.totals);
  const total = (key: string) => {
    const row = asRecord(totals[key]);
    return { chats: salesNumber(row.chats), bought: salesNumber(row.bought) };
  };
  return {
    kind: "ok",
    data: {
      days: salesNumber(result.data.days, 30),
      leads: salesRows(result.data.leads).map((row) => ({
        conversationId: salesNumber(row.conversation_id),
        contactName: salesText(row.contact_name),
        score: salesNumber(row.score),
        label: salesLabel(row.label),
        stageHint: salesText(row.stage_hint),
        product: salesText(row.product),
        concerns: Array.isArray(row.concerns) ? row.concerns.map(salesText).filter(Boolean) : [],
        bought: row.bought === true,
        updatedAt: salesText(row.updated_at) || null,
      })),
      concerns: salesRows(result.data.concerns).map((row) => ({
        kind: salesText(row.kind),
        label: salesText(row.label),
        chats: salesNumber(row.chats),
        bought: salesNumber(row.bought),
        rate: salesNumber(row.rate),
        hasAnswer: row.has_answer === true,
      })),
      totals: { hot: total("hot"), warm: total("warm"), cold: total("cold") },
    },
  };
}

export async function createSalesQuote(
  accessToken: string,
  input: SalesQuoteInput
): Promise<ServiceResult<{ link: SalesQuote }>> {
  const result = await portalService<Record<string, unknown>>(accessToken, SALES + "/quotes", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: input.conversationId,
      items: input.items.map((item) => ({ catalog_id: item.catalogId, qty: item.qty })),
      discount_percent: input.discountPercent,
      ...(input.expiresInDays === null ? {} : { expires_in_days: input.expiresInDays }),
      title: input.title,
    }),
  });
  if (result.kind !== "ok") return result;
  const link = asRecord(result.data.link);
  return {
    kind: "ok",
    data: {
      link: {
        id: salesNumber(link.id),
        token: salesText(link.token),
        title: salesText(link.title),
        total: salesNumber(link.total),
        discount: salesNumber(link.discount),
        items: salesRows(link.items).map((row) => ({
          name: salesText(row.name), qty: salesNumber(row.qty, 1), price: salesNumber(row.price),
        })),
        expiresAt: salesText(link.expires_at) || null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Retention & loyalty (§238): tiers, tier offers, timed reorder / win-back
// messages (opt-in) and their results.
// ---------------------------------------------------------------------------

export type LoyaltyKind = "reorder" | "winback";

export interface LoyaltyTier {
  key: string;
  label: string;
  minOrders: number;
  minSpend: number;
  coupon: string;
}

export interface LoyaltySettings {
  autoReorder: boolean;
  autoWinback: boolean;
  brainContext: boolean;
  dailyCap: number;
  cooldownDays: number;
  windowStart: number;
  windowEnd: number;
  tplReorder: string;
  tplWinback: string;
  tplOffer: string;
  tiers: LoyaltyTier[];
  lastRunAt: string | null;
}

export interface LoyaltySettingsView {
  settings: LoyaltySettings;
  defaults: { reorder: string; winback: string; offer: string };
  placeholders: string[];
  coupons: { code: string; kind: string; value: number }[];
  canEdit: boolean;
  everyMinutes: number;
  capMax: number;
}

export interface LoyaltySkipped {
  optedOut: number;
  openCart: number;
  inSequence: number;
  cooldown: number;
  noChat: number;
}

export interface LoyaltyOverview {
  days: number;
  attributionDays: number;
  customers: number;
  tiers: { key: string; label: string; customers: number; spend: number }[];
  due: { reorder: number; winback: number };
  ready: number;
  skipped: LoyaltySkipped;
  sentLastDay: number;
  dailyCap: number;
  auto: { reorder: boolean; winback: boolean };
  lastRunAt: string | null;
  results: { kind: string; sent: number; returned: number; revenue: number }[];
  totals: { sent: number; returned: number; revenue: number };
  recent: {
    contactId: string;
    name: string;
    kind: string;
    tier: string;
    coupon: string;
    mode: string;
    createdAt: string | null;
    returned: boolean;
  }[];
}

export interface LoyaltyCustomer {
  contactId: string;
  orders: number;
  spend: number;
  favourite: string;
  lastOrderDays: number | null;
  tier: { key: string; label: string } | null;
  next: { label: string; ordersNeeded: number; spendNeeded: number } | null;
  optedOut: boolean;
  due: { kind: string; item: string; message: string; held: string } | null;
  lastSend: { kind: string; mode: string; createdAt: string | null } | null;
}

export interface LoyaltyRunResult {
  dryRun: boolean;
  sent: number;
  room: number;
  due: { reorder: number; winback: number };
  skipped: LoyaltySkipped;
  messages: { contactId: string; name: string; kind: string; tier: string; coupon: string; message: string }[];
}

const RETENTION = "api/v1/portal/retention";

function retText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function retNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function retRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : [];
}

function retSkipped(value: unknown): LoyaltySkipped {
  const row = asRecord(value);
  return {
    optedOut: retNumber(row.opted_out),
    openCart: retNumber(row.open_cart),
    inSequence: retNumber(row.in_sequence),
    cooldown: retNumber(row.cooldown),
    noChat: retNumber(row.no_chat),
  };
}

function retDue(value: unknown): { reorder: number; winback: number } {
  const row = asRecord(value);
  return { reorder: retNumber(row.reorder), winback: retNumber(row.winback) };
}

function retSettings(value: unknown): LoyaltySettings {
  const row = asRecord(value);
  return {
    autoReorder: row.auto_reorder === true,
    autoWinback: row.auto_winback === true,
    brainContext: row.brain_context !== false,
    dailyCap: retNumber(row.daily_cap, 20),
    cooldownDays: retNumber(row.cooldown_days, 7),
    windowStart: retNumber(row.window_start, 10),
    windowEnd: retNumber(row.window_end, 20),
    tplReorder: retText(row.tpl_reorder),
    tplWinback: retText(row.tpl_winback),
    tplOffer: retText(row.tpl_offer),
    tiers: retRows(row.tiers).map((tier) => ({
      key: retText(tier.key),
      label: retText(tier.label),
      minOrders: retNumber(tier.min_orders, 1),
      minSpend: retNumber(tier.min_spend),
      coupon: retText(tier.coupon),
    })),
    lastRunAt: retText(row.last_run_at) || null,
  };
}

export async function getLoyaltySettings(accessToken: string): Promise<ServiceResult<LoyaltySettingsView>> {
  const result = await portalService<Record<string, unknown>>(accessToken, RETENTION + "/settings", { method: "GET" });
  if (result.kind !== "ok") return result;
  const defaults = asRecord(result.data.defaults);
  return {
    kind: "ok",
    data: {
      settings: retSettings(result.data.settings),
      defaults: { reorder: retText(defaults.reorder), winback: retText(defaults.winback), offer: retText(defaults.offer) },
      placeholders: Array.isArray(result.data.placeholders) ? result.data.placeholders.map(retText).filter(Boolean) : [],
      coupons: retRows(result.data.coupons).map((row) => ({
        code: retText(row.code), kind: retText(row.kind), value: retNumber(row.value),
      })),
      canEdit: result.data.can_edit === true,
      everyMinutes: retNumber(result.data.every_minutes, 60),
      capMax: retNumber(result.data.cap_max, 200),
    },
  };
}

export async function saveLoyaltySettings(
  accessToken: string,
  input: Partial<Omit<LoyaltySettings, "lastRunAt">>
): Promise<ServiceResult<{ settings: LoyaltySettings }>> {
  const body: Record<string, unknown> = {};
  if (typeof input.autoReorder === "boolean") body.auto_reorder = input.autoReorder;
  if (typeof input.autoWinback === "boolean") body.auto_winback = input.autoWinback;
  if (typeof input.brainContext === "boolean") body.brain_context = input.brainContext;
  if (typeof input.dailyCap === "number") body.daily_cap = input.dailyCap;
  if (typeof input.cooldownDays === "number") body.cooldown_days = input.cooldownDays;
  if (typeof input.windowStart === "number") body.window_start = input.windowStart;
  if (typeof input.windowEnd === "number") body.window_end = input.windowEnd;
  if (typeof input.tplReorder === "string") body.tpl_reorder = input.tplReorder;
  if (typeof input.tplWinback === "string") body.tpl_winback = input.tplWinback;
  if (typeof input.tplOffer === "string") body.tpl_offer = input.tplOffer;
  if (Array.isArray(input.tiers)) {
    body.tiers = input.tiers.map((tier) => ({
      label: tier.label, min_orders: tier.minOrders, min_spend: tier.minSpend, coupon: tier.coupon,
    }));
  }
  const result = await portalService<Record<string, unknown>>(
    accessToken, RETENTION + "/settings", { method: "PUT", body: JSON.stringify(body) });
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: { settings: retSettings(result.data.settings) } };
}

export async function getLoyaltyOverview(accessToken: string): Promise<ServiceResult<LoyaltyOverview>> {
  const result = await portalService<Record<string, unknown>>(accessToken, RETENTION + "/overview", { method: "GET" });
  if (result.kind !== "ok") return result;
  const data = result.data;
  const totals = asRecord(data.totals);
  const auto = asRecord(data.auto);
  return {
    kind: "ok",
    data: {
      days: retNumber(data.days, 30),
      attributionDays: retNumber(data.attribution_days, 14),
      customers: retNumber(data.customers),
      tiers: retRows(data.tiers).map((row) => ({
        key: retText(row.key), label: retText(row.label), customers: retNumber(row.customers), spend: retNumber(row.spend),
      })),
      due: retDue(data.due),
      ready: retNumber(data.ready),
      skipped: retSkipped(data.skipped),
      sentLastDay: retNumber(data.sent_last_day),
      dailyCap: retNumber(data.daily_cap),
      auto: { reorder: auto.reorder === true, winback: auto.winback === true },
      lastRunAt: retText(data.last_run_at) || null,
      results: Object.entries(asRecord(data.results)).map(([kind, value]) => {
        const row = asRecord(value);
        return { kind, sent: retNumber(row.sent), returned: retNumber(row.returned), revenue: retNumber(row.revenue) };
      }),
      totals: { sent: retNumber(totals.sent), returned: retNumber(totals.returned), revenue: retNumber(totals.revenue) },
      recent: retRows(data.recent).map((row) => ({
        contactId: retText(row.contact_id),
        name: retText(row.name),
        kind: retText(row.kind),
        tier: retText(row.tier),
        coupon: retText(row.coupon),
        mode: retText(row.mode),
        createdAt: retText(row.created_at) || null,
        returned: row.returned === true,
      })),
    },
  };
}

export async function getLoyaltyCustomer(
  accessToken: string,
  contactId: string
): Promise<ServiceResult<LoyaltyCustomer>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, RETENTION + "/customer?contact_id=" + encodeURIComponent(contactId), { method: "GET" });
  if (result.kind !== "ok") return result;
  const data = result.data;
  const tier = data.tier ? asRecord(data.tier) : null;
  const next = data.next ? asRecord(data.next) : null;
  const due = data.due ? asRecord(data.due) : null;
  const last = data.last_send ? asRecord(data.last_send) : null;
  return {
    kind: "ok",
    data: {
      contactId: retText(data.contact_id),
      orders: retNumber(data.orders),
      spend: retNumber(data.spend),
      favourite: retText(data.favourite),
      lastOrderDays: typeof data.last_order_days === "number" ? data.last_order_days : null,
      tier: tier ? { key: retText(tier.key), label: retText(tier.label) } : null,
      next: next
        ? { label: retText(next.label), ordersNeeded: retNumber(next.orders_needed), spendNeeded: retNumber(next.spend_needed) }
        : null,
      optedOut: data.opted_out === true,
      due: due
        ? { kind: retText(due.kind), item: retText(due.item), message: retText(due.message), held: retText(due.held) }
        : null,
      lastSend: last ? { kind: retText(last.kind), mode: retText(last.mode), createdAt: retText(last.created_at) || null } : null,
    },
  };
}

export async function runLoyaltyMessages(accessToken: string, dryRun: boolean): Promise<ServiceResult<LoyaltyRunResult>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, RETENTION + "/run", { method: "POST", body: JSON.stringify({ dry_run: dryRun }) });
  if (result.kind !== "ok") return result;
  const data = result.data;
  return {
    kind: "ok",
    data: {
      dryRun: data.dry_run !== false,
      sent: retNumber(data.sent),
      room: retNumber(data.room),
      due: retDue(data.due),
      skipped: retSkipped(data.skipped),
      messages: retRows(data.messages).map((row) => ({
        contactId: retText(row.contact_id),
        name: retText(row.name),
        kind: retText(row.kind),
        tier: retText(row.tier),
        coupon: retText(row.coupon),
        message: retText(row.message),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Notification email templates (§239): per-kind subject + body with
// variables; no saved template = the built-in default (CP: portal_notify).
// ---------------------------------------------------------------------------

export interface NotifyTemplate {
  kind: string;
  label: string;
  custom: boolean;
  subject: string;
  body: string;
  updatedAt: string | null;
}

export interface NotifyTemplatesView {
  templates: NotifyTemplate[];
  defaults: { subject: string; body: string };
  variables: { key: string; description: string }[];
  subjectMax: number;
  bodyMax: number;
  canEdit: boolean;
}

const NOTIFY_TEMPLATES = "api/v1/portal/notifications/templates";

function notifyText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function notifyTemplatesView(raw: Record<string, unknown>): NotifyTemplatesView {
  const rows = Array.isArray(raw.templates) ? (raw.templates as Record<string, unknown>[]) : [];
  const defaults = (raw.defaults ?? {}) as Record<string, unknown>;
  const variables = Array.isArray(raw.variables) ? (raw.variables as Record<string, unknown>[]) : [];
  return {
    templates: rows.map((row) => ({
      kind: notifyText(row.kind),
      label: notifyText(row.label),
      custom: row.custom === true,
      subject: notifyText(row.subject),
      body: notifyText(row.body),
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    })),
    defaults: { subject: notifyText(defaults.subject), body: notifyText(defaults.body) },
    variables: variables.map((item) => ({ key: notifyText(item.key), description: notifyText(item.description) })),
    subjectMax: typeof raw.subject_max === "number" ? raw.subject_max : 200,
    bodyMax: typeof raw.body_max === "number" ? raw.body_max : 2000,
    canEdit: raw.can_edit === true,
  };
}

async function notifyTemplatesResult(
  pending: Promise<ServiceResult<Record<string, unknown>>>
): Promise<ServiceResult<NotifyTemplatesView>> {
  const result = await pending;
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: notifyTemplatesView(result.data) };
}

export function getNotifyTemplates(accessToken: string) {
  return notifyTemplatesResult(
    portalService<Record<string, unknown>>(accessToken, NOTIFY_TEMPLATES, { method: "GET" }));
}

export function saveNotifyTemplate(accessToken: string, kind: string, subject: string, body: string) {
  return notifyTemplatesResult(
    portalService<Record<string, unknown>>(accessToken, NOTIFY_TEMPLATES + "/" + encodeURIComponent(kind), {
      method: "PUT",
      body: JSON.stringify({ subject, body }),
    }));
}

export function resetNotifyTemplate(accessToken: string, kind: string) {
  return notifyTemplatesResult(
    portalService<Record<string, unknown>>(accessToken, NOTIFY_TEMPLATES + "/" + encodeURIComponent(kind), {
      method: "DELETE",
    }));
}

export function previewNotifyTemplate(accessToken: string, kind: string, subject: string, body: string) {
  return portalService<{ subject: string; body: string }>(accessToken, NOTIFY_TEMPLATES + "/preview", {
    method: "POST",
    body: JSON.stringify({ kind, subject, body }),
  });
}

// ---------------------------------------------------------------------------
// §240 AI + automation analytics quadrant (read-only)
// ---------------------------------------------------------------------------

const AI_AUTOMATION = "api/v1/portal/analytics/ai-automation";

export interface AiAutomationAgent {
  agentId: number | null;
  name: string;
  answers: number;
  sent: number;
  handedOff: number;
  avgConfidence: number | null;
  calls: number;
  costUsd: number | null;
}

export interface AiAutomationView {
  days: number;
  generatedAt: string;
  ai: {
    answers: {
      available: boolean;
      automatic: number;
      sent: number;
      handedOff: number;
      sentShare: number | null;
      drafts: number;
      draftsUsable: number;
      confidence: { average: number | null; scored: number; high: number; ok: number; low: number };
      tools: { key: string; label: string; count: number; share: number | null }[];
      noTool: number;
      reasons: { reason: string; label: string; count: number }[];
      agents: AiAutomationAgent[];
    };
    usage: {
      available: boolean;
      calls: number;
      failed: number;
      failShare: number | null;
      tokens: number;
      avgLatencyMs: number;
      costUsd: number | null;
      priced: boolean;
      features: { feature: string; label: string; calls: number; costUsd: number | null }[];
    };
    bands: { highFrom: number; lowBelow: number };
  };
  automation: {
    workflows: {
      available: boolean;
      runs: number;
      completed: number;
      goalReached: number;
      stopped: number;
      failed: number;
      inProgress: number;
      waitingApproval: number;
      steps: number;
      goalShare: number | null;
      failureShare: number | null;
      top: { workflowId: number; name: string; runs: number; goalReached: number; failed: number }[];
      failures: { runId: number; workflowId: number; name: string; error: string; at: string | null }[];
    };
    actions: {
      available: boolean;
      total: number;
      byOutcome: { executed: number; approvalRequired: number; denied: number; error: number; running: number };
      byActor: { ai: number; workflow: number; approval: number; person: number };
      keptDays: number;
    };
    sequences: {
      available: boolean;
      enrolled: number;
      active: number;
      completed: number;
      stopped: number;
      paused: number;
      sent: number;
      skipped: number;
    };
  };
}

/** A number, or null when the Control Plane sent null (nothing to divide / not priced). */
function qNullable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function aiAutomationView(raw: Record<string, unknown>): AiAutomationView {
  const ai = asRecord(raw.ai);
  const answers = asRecord(ai.answers);
  const confidence = asRecord(answers.confidence);
  const usage = asRecord(ai.usage);
  const bands = asRecord(ai.confidence_bands);
  const automation = asRecord(raw.automation);
  const flows = asRecord(automation.workflows);
  const actions = asRecord(automation.actions);
  const outcome = asRecord(actions.by_outcome);
  const actor = asRecord(actions.by_actor);
  const sequences = asRecord(automation.sequences);
  return {
    days: retNumber(raw.days, 30),
    generatedAt: retText(raw.generated_at),
    ai: {
      answers: {
        available: answers.available === true,
        automatic: retNumber(answers.automatic),
        sent: retNumber(answers.sent),
        handedOff: retNumber(answers.handed_off),
        sentShare: qNullable(answers.sent_share),
        drafts: retNumber(answers.drafts),
        draftsUsable: retNumber(answers.drafts_usable),
        confidence: {
          average: qNullable(confidence.average),
          scored: retNumber(confidence.scored),
          high: retNumber(confidence.high),
          ok: retNumber(confidence.ok),
          low: retNumber(confidence.low),
        },
        tools: retRows(answers.tools).map((row) => ({
          key: retText(row.key),
          label: retText(row.label) || retText(row.key),
          count: retNumber(row.count),
          share: qNullable(row.share),
        })),
        noTool: retNumber(answers.no_tool),
        reasons: retRows(answers.reasons).map((row) => ({
          reason: retText(row.reason),
          label: retText(row.label) || retText(row.reason),
          count: retNumber(row.count),
        })),
        agents: retRows(answers.agents).map((row) => ({
          agentId: qNullable(row.agent_id),
          name: retText(row.name),
          answers: retNumber(row.answers),
          sent: retNumber(row.sent),
          handedOff: retNumber(row.handed_off),
          avgConfidence: qNullable(row.avg_confidence),
          calls: retNumber(row.calls),
          costUsd: qNullable(row.cost_usd),
        })),
      },
      usage: {
        available: usage.available === true,
        calls: retNumber(usage.calls),
        failed: retNumber(usage.failed),
        failShare: qNullable(usage.fail_share),
        tokens: retNumber(usage.tokens),
        avgLatencyMs: retNumber(usage.avg_latency_ms),
        costUsd: qNullable(usage.cost_usd),
        priced: usage.priced === true,
        features: retRows(usage.features).map((row) => ({
          feature: retText(row.feature),
          label: retText(row.label) || retText(row.feature),
          calls: retNumber(row.calls),
          costUsd: qNullable(row.cost_usd),
        })),
      },
      bands: { highFrom: retNumber(bands.high_from, 0.8), lowBelow: retNumber(bands.low_below, 0.6) },
    },
    automation: {
      workflows: {
        available: flows.available === true,
        runs: retNumber(flows.runs),
        completed: retNumber(flows.completed),
        goalReached: retNumber(flows.goal_reached),
        stopped: retNumber(flows.stopped),
        failed: retNumber(flows.failed),
        inProgress: retNumber(flows.in_progress),
        waitingApproval: retNumber(flows.waiting_approval),
        steps: retNumber(flows.steps),
        goalShare: qNullable(flows.goal_share),
        failureShare: qNullable(flows.failure_share),
        top: retRows(flows.top).map((row) => ({
          workflowId: retNumber(row.workflow_id),
          name: retText(row.name),
          runs: retNumber(row.runs),
          goalReached: retNumber(row.goal_reached),
          failed: retNumber(row.failed),
        })),
        failures: retRows(flows.failures).map((row) => ({
          runId: retNumber(row.run_id),
          workflowId: retNumber(row.workflow_id),
          name: retText(row.name),
          error: retText(row.error),
          at: typeof row.at === "string" ? row.at : null,
        })),
      },
      actions: {
        available: actions.available === true,
        total: retNumber(actions.total),
        byOutcome: {
          executed: retNumber(outcome.executed),
          approvalRequired: retNumber(outcome.approval_required),
          denied: retNumber(outcome.denied),
          error: retNumber(outcome.error),
          running: retNumber(outcome.running),
        },
        byActor: {
          ai: retNumber(actor.ai),
          workflow: retNumber(actor.workflow),
          approval: retNumber(actor.approval),
          person: retNumber(actor.person),
        },
        keptDays: retNumber(actions.kept_days, 30),
      },
      sequences: {
        available: sequences.available === true,
        enrolled: retNumber(sequences.enrolled),
        active: retNumber(sequences.active),
        completed: retNumber(sequences.completed),
        stopped: retNumber(sequences.stopped),
        paused: retNumber(sequences.paused),
        sent: retNumber(sequences.sent),
        skipped: retNumber(sequences.skipped),
      },
    },
  };
}

export async function getAiAutomation(
  accessToken: string,
  days: number
): Promise<ServiceResult<AiAutomationView>> {
  const result = await portalService<Record<string, unknown>>(
    accessToken, AI_AUTOMATION + "?days=" + encodeURIComponent(String(days)), { method: "GET" });
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: aiAutomationView(asRecord(result.data)) };
}

/** §241 AI execution traces: what each AI answer read, cost and decided. */
const AI_TRACES = "api/v1/portal/ai/traces";

export interface AiTraceSummary {
  id: number;
  created_at: string | null;
  kind: string;
  kind_label: string;
  decision: string;
  conversation_id: number | null;
  agent: { id: number; name: string } | null;
  model: string | null;
  tokens: number;
  latency_ms: number | null;
  cost_usd: number | null;
  confidence: number | null;
  reason: { key: string; label: string; detail: string } | null;
  tools: string[];
  llm_called: boolean;
}

export interface AiTraceList {
  days: number;
  filters: { kind: string; decision: string; agent_id: number; conversation_id: number };
  kinds: { key: string; label: string }[];
  prices_configured: boolean;
  items: AiTraceSummary[];
}

export interface AiTraceStep {
  key: "input" | "guard" | "agent" | "tools" | "model" | "decision" | "response";
  label: string;
  status: "ok" | "warn" | "blocked" | "failed" | "skipped" | "unknown";
  detail: Record<string, unknown>;
}

export interface AiTraceDetail {
  id: number;
  created_at: string | null;
  kind: string;
  kind_label: string;
  decision: string;
  conversation_id: number | null;
  channel: string | null;
  steps: AiTraceStep[];
  audit: { id: number; action: string; actor_kind: string; note: string }[];
}

export interface AiTraceQuery {
  days: number;
  kind?: string;
  decision?: string;
  agentId?: number;
  conversationId?: number;
  limit?: number;
}

export function listAiTraces(accessToken: string, query: AiTraceQuery) {
  const params = new URLSearchParams({ days: String(query.days) });
  if (query.kind) params.set("kind", query.kind);
  if (query.decision) params.set("decision", query.decision);
  if (query.agentId) params.set("agent_id", String(query.agentId));
  if (query.conversationId) params.set("conversation_id", String(query.conversationId));
  if (query.limit) params.set("limit", String(query.limit));
  return portalService<AiTraceList>(accessToken, AI_TRACES + "?" + params.toString(), { method: "GET" });
}

export function getAiTrace(accessToken: string, traceId: number) {
  return portalService<AiTraceDetail>(
    accessToken, AI_TRACES + "/" + encodeURIComponent(String(traceId)), { method: "GET" });
}

/** §242 proactive business alerts: demand and complaint patterns, raised as they appear. */
const PROACTIVE = "api/v1/portal/proactive";

export interface ProactiveParam {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
}

export interface ProactiveRule {
  key: string;
  label: string;
  description: string;
  severity: string;
  enabled: boolean;
  params: ProactiveParam[];
}

export interface ProactiveAlert {
  id: number;
  rule: string;
  rule_label: string;
  severity: string;
  title: string;
  detail: string;
  href: string;
  conversation_id: number | null;
  created_at: string | null;
}

export interface ProactiveState {
  enabled: boolean;
  available: boolean;
  rules: ProactiveRule[];
  recent: ProactiveAlert[];
  last_run_at: string | null;
  every_minutes: number;
  can_edit: boolean;
}

export interface ProactiveRun {
  ok: boolean;
  checked: number;
  alerts: ProactiveAlert[];
}

export interface ProactiveChange {
  enabled?: boolean;
  rules?: Record<string, Record<string, boolean | number>>;
}

export function getProactive(accessToken: string) {
  return portalService<ProactiveState>(accessToken, PROACTIVE, { method: "GET" });
}

export function saveProactive(accessToken: string, change: ProactiveChange) {
  return portalService<ProactiveState>(accessToken, PROACTIVE, { method: "PUT", body: JSON.stringify(change) });
}

export function runProactiveCheck(accessToken: string) {
  return portalService<ProactiveRun>(accessToken, PROACTIVE + "/run", { method: "POST" });
}
