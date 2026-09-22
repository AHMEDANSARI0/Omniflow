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
}

export interface KbEntryInput {
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  lang: KbLang;
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
}

export interface WebhookDelivery {
  id: number;
  event: string;
  statusCode: number | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  deliveredAt: string | null;
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
  const secret = (payload as Record<string, unknown>).secret;
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
  payment: PublicCheckoutPayment | null;
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
}

export async function createCheckoutLink(
  accessToken: string,
  contactId: string,
  title: string,
  items: { name: string; qty: number; price: number }[],
  expiresInDays?: number | null,
  discountAmount?: number | null
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
}

export interface BrainDraftResult {
  decision: string;
  draft: string;
  grounding: Record<string, unknown> | null;
  autonomy?: string;
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
  return (await response.json().catch(() => null)) as BrainDraftResult | null;
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
  content: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, kind, content }),
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
  content: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
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

export interface RoutingRule {
  id: number;
  match: string;
  userId: number;
  priority: number;
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
    }));
}

export async function addRoutingRule(
  accessToken: string,
  match: string,
  userId: number,
  priority: number
): Promise<RoutingRule | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/routing/rules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match, user_id: userId, priority }),
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
}

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
