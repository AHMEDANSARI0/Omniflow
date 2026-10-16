/**
 * §277 P2 portal API - dashboard, unified inbox and WhatsApp state.
 * Everything is served by the EXISTING Control Plane (portal_analytics.py,
 * portal_conversations.py, portal_channels.py) with the client's bearer
 * session: no second backend, no direct DB access from the app.
 *
 * Fail-soft by design: every payload passes through a tolerant zod schema so
 * a missing/renamed CP field degrades to a safe default instead of crashing
 * a screen.
 */

import { z } from "zod";
import { api } from "@/api/client";

const n0 = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0))
  .catch(0);

const nOrNull = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
  .catch(null);

const str = (fallback = "") =>
  z
    .string()
    .nullish()
    .transform((v) => (typeof v === "string" ? v : fallback))
    .catch(fallback);

const bool = (fallback = false) =>
  z
    .boolean()
    .nullish()
    .transform((v) => (typeof v === "boolean" ? v : fallback))
    .catch(fallback);

// ---------------------------------------------------------------------------
// Conversations (unified inbox)
// ---------------------------------------------------------------------------

export const conversationSchema = z.object({
  id: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) =>
      typeof v === "number" ? v : parseInt(String(v ?? ""), 10) || 0,
    )
    .catch(0),
  channel: str("whatsapp"),
  contact_id: str(),
  contact_name: str(),
  status: str("open"),
  last_message_at: str(),
  last_message_preview: str(),
  created_at: str(),
  unread: bool(false),
  needs_reply: bool(false),
  last_intent: str(),
  lead_score: n0,
  lead_temp: str("cold"),
  assigned_to: str(),
  assignee_name: str(),
  starred: bool(false),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const inboxCountsSchema = z.object({
  needs_reply: n0,
  overdue: n0,
  unassigned: n0,
  unread: n0,
});
export type InboxCounts = z.infer<typeof inboxCountsSchema>;

export const conversationListSchema = z.object({
  conversations: z.array(conversationSchema).catch([]),
  counts: inboxCountsSchema
    .optional()
    .transform((v) => v ?? null)
    .catch(null),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

export const conversationDetailSchema = z.object({
  conversation: conversationSchema,
});

export interface ListConversationsInput {
  /** server-side filter: all | open | closed (CP ALLOWED_STATUS) */
  status?: "all" | "open" | "closed";
  /** free-text search over contact name / id / preview */
  q?: string;
  limit?: number;
}

export async function listConversations(
  input: ListConversationsInput = {},
): Promise<ConversationList> {
  const params = new URLSearchParams({ include: "counts" });
  params.set("limit", String(input.limit ?? 50));
  if (input.status && input.status !== "all") params.set("status", input.status);
  if (input.q) params.set("q", input.q);
  const data = await api.get<unknown>(
    "/api/v1/portal/conversations?" + params.toString(),
  );
  return conversationListSchema.parse(data ?? {});
}

export async function fetchConversation(
  id: number,
): Promise<Conversation | null> {
  const data = await api.get<unknown>(`/api/v1/portal/conversations/${id}`);
  const parsed = conversationDetailSchema.safeParse(data ?? {});
  return parsed.success ? parsed.data.conversation : null;
}

// ---------------------------------------------------------------------------
// Messages (thread + human replies)
// ---------------------------------------------------------------------------

export const messageSchema = z.object({
  /** bigint-safe: kept as a string for keys and `before_id` pagination */
  id: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? "" : String(v)))
    .catch(""),
  direction: z.enum(["in", "out"]).catch("in"),
  body: str(),
  status: str("received"),
  intent: str(),
  created_at: str(),
});
export type Message = z.infer<typeof messageSchema>;

export const messagePageSchema = z.object({
  messages: z.array(messageSchema).catch([]),
  has_more: bool(false),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

export async function fetchMessages(
  conversationId: number,
  beforeId?: string,
): Promise<MessagePage> {
  const suffix = beforeId
    ? "?before_id=" + encodeURIComponent(beforeId)
    : "";
  const data = await api.get<unknown>(
    `/api/v1/portal/conversations/${conversationId}/messages${suffix}`,
  );
  return messagePageSchema.parse(data ?? {});
}

export async function sendReply(
  conversationId: number,
  body: string,
): Promise<void> {
  await api.post<unknown>(
    `/api/v1/portal/conversations/${conversationId}/messages`,
    { body },
  );
}

// ---------------------------------------------------------------------------
// WhatsApp channel state
// ---------------------------------------------------------------------------

export const whatsappStatusSchema = z.object({
  state: z.enum(["disconnected", "connecting", "connected"]).catch("disconnected"),
  account_name: str(),
  phone: str(),
  last_seen_at: str(),
});
export type WhatsappStatus = z.infer<typeof whatsappStatusSchema>;

export async function fetchWhatsappStatus(): Promise<WhatsappStatus> {
  const data = await api.get<unknown>("/api/v1/portal/channels/whatsapp");
  return whatsappStatusSchema.parse(data ?? {});
}

// ---------------------------------------------------------------------------
// Dashboard operations snapshot
// ---------------------------------------------------------------------------

const operationsShape = z.object({
  chats: z
    .object({ new: n0, open: n0, total: n0 })
    .catch({ new: 0, open: 0, total: 0 }),
  messages: z
    .object({ received: n0, sent: n0 })
    .catch({ received: 0, sent: 0 }),
  orders: z
    .object({ paid: n0, revenue: n0 })
    .catch({ paid: 0, revenue: 0 }),
  deliveries: z
    .object({ bookings: n0, by_status: z.record(z.string(), n0).catch({}) })
    .catch({ bookings: 0, by_status: {} }),
  recovery: z
    .object({ open: n0, resolved: n0 })
    .catch({ open: 0, resolved: 0 }),
  csat: z
    .object({ answers: n0, avg_score: nOrNull })
    .catch({ answers: 0, avg_score: null }),
});

const operationsFallback = {
  chats: { new: 0, open: 0, total: 0 },
  messages: { received: 0, sent: 0 },
  orders: { paid: 0, revenue: 0 },
  deliveries: { bookings: 0, by_status: {} as Record<string, number> },
  recovery: { open: 0, resolved: 0 },
  csat: { answers: 0, avg_score: null as number | null },
};

export const operationsSchema = operationsShape.catch(operationsFallback);
export type Operations = z.infer<typeof operationsSchema>;

export const operationsEnvelopeSchema = z.object({
  days: n0,
  operations: operationsSchema,
});
export type OperationsEnvelope = z.infer<typeof operationsEnvelopeSchema>;

export async function fetchOperations(days = 7): Promise<OperationsEnvelope> {
  const safe = [1, 7, 14, 30].includes(days) ? days : 7;
  const data = await api.get<unknown>(
    `/api/v1/portal/insights/operations?days=${safe}`,
  );
  return operationsEnvelopeSchema.parse(data ?? {});
}
