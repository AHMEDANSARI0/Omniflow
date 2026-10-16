/**
 * §277 P2 portal schemas: every CP payload must degrade to safe defaults
 * (fail-soft law) - a missing field never crashes a screen, and ids stay
 * bigint-safe strings for `before_id` paging.
 */

import {
  conversationListSchema,
  messagePageSchema,
  operationsEnvelopeSchema,
  whatsappStatusSchema,
} from "@/api/portal";

describe("portal api schemas (§277)", () => {
  it("normalizes a full conversation list payload", () => {
    const parsed = conversationListSchema.parse({
      conversations: [
        {
          id: 42,
          channel: "whatsapp",
          contact_name: "Ali",
          status: "open",
          last_message_at: "2026-10-15T10:00:00+00:00",
          last_message_preview: "Salam",
          unread: true,
          needs_reply: false,
          lead_score: 7,
          lead_temp: "warm",
          starred: false,
          tags: ["vip"],
        },
      ],
      counts: { needs_reply: 2, overdue: 0, unassigned: 1, unread: 3 },
    });
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]!.id).toBe(42);
    expect(parsed.conversations[0]!.unread).toBe(true);
    expect(parsed.counts?.unread).toBe(3);
  });

  it("falls back to safe defaults on junk conversation fields", () => {
    const parsed = conversationListSchema.parse({
      conversations: [{ id: "17", weird: true }],
    });
    expect(parsed.conversations[0]!.id).toBe(17);
    expect(parsed.conversations[0]!.channel).toBe("whatsapp");
    expect(parsed.conversations[0]!.status).toBe("open");
    expect(parsed.conversations[0]!.unread).toBe(false);
    expect(parsed.counts).toBeNull();
  });

  it("tolerates a completely empty payload", () => {
    const parsed = conversationListSchema.parse({});
    expect(parsed.conversations).toEqual([]);
  });

  it("keeps message ids as strings for bigint-safe paging", () => {
    const parsed = messagePageSchema.parse({
      messages: [
        { id: "9007199254740993", direction: "out", body: "Ji", status: "sent" },
        { id: 5, direction: "in", body: "OK" },
      ],
      has_more: true,
    });
    expect(parsed.messages[0]!.id).toBe("9007199254740993");
    expect(parsed.messages[1]!.id).toBe("5");
    expect(parsed.messages[1]!.direction).toBe("in");
    expect(parsed.messages[1]!.status).toBe("received");
    expect(parsed.has_more).toBe(true);
  });

  it("clamps unknown whatsapp states to disconnected", () => {
    expect(
      whatsappStatusSchema.parse({ state: "connected", phone: "+92300" }).state,
    ).toBe("connected");
    expect(whatsappStatusSchema.parse({ state: "broken" }).state).toBe("disconnected");
    expect(whatsappStatusSchema.parse({}).phone).toBe("");
  });

  it("defaults every operations metric to zero", () => {
    const parsed = operationsEnvelopeSchema.parse({
      days: 7,
      operations: { chats: { new: 3 }, orders: { revenue: 1500.5 } },
    });
    expect(parsed.days).toBe(7);
    expect(parsed.operations.chats.new).toBe(3);
    expect(parsed.operations.chats.open).toBe(0);
    expect(parsed.operations.orders.revenue).toBe(1500.5);
    expect(parsed.operations.orders.paid).toBe(0);
    expect(parsed.operations.csat.avg_score).toBeNull();
    expect(parsed.operations.deliveries.by_status).toEqual({});
  });

  it("survives a missing operations object entirely", () => {
    const parsed = operationsEnvelopeSchema.parse({ days: 30 });
    expect(parsed.days).toBe(30);
    expect(parsed.operations.messages.received).toBe(0);
  });
});
