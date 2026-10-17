/**
 * §279 P4 notification core: prefs schema defaults, deep-link payload
 * parsing, alert copy and the unread-delta rule (pure module - no native
 * imports, so these run in plain jest).
 */

import {
  CHANNEL_ID,
  DEFAULT_PREFS,
  buildNotificationBody,
  diffNewUnread,
  notificationDataSchema,
  notificationPrefsSchema,
} from "@/lib/notifyCore";

describe("notification prefs (§279)", () => {
  it("defaults everything to on and survives junk", () => {
    expect(notificationPrefsSchema.parse({})).toEqual(DEFAULT_PREFS);
    expect(notificationPrefsSchema.parse({ notifications: false }).sounds).toBe(true);
    expect(notificationPrefsSchema.parse({ haptics: "yes" }).haptics).toBe(true);
  });

  it("keeps explicit choices", () => {
    const parsed = notificationPrefsSchema.parse({
      notifications: true,
      sounds: false,
      haptics: true,
    });
    expect(parsed.sounds).toBe(false);
  });
});

describe("notification data (§279)", () => {
  it("parses deep-link payloads", () => {
    expect(notificationDataSchema.parse({ conversationId: 42 }).conversationId).toBe("42");
    expect(notificationDataSchema.parse({ conversationId: "7" }).conversationId).toBe("7");
    expect(notificationDataSchema.parse({ tab: "inbox" }).tab).toBe("inbox");
  });

  it("falls back to null/empty", () => {
    const parsed = notificationDataSchema.parse({});
    expect(parsed.conversationId).toBeNull();
    expect(parsed.tab).toBe("");
    expect(notificationDataSchema.parse({ conversationId: {} }).conversationId).toBeNull();
  });
});

describe("alert copy (§279)", () => {
  it("builds single vs plural titles", () => {
    expect(buildNotificationBody("Salam bhai", 1)).toEqual({
      title: "New message",
      body: "Salam bhai",
    });
    expect(buildNotificationBody("Salam", 3).title).toBe("3 new messages");
  });

  it("has fallbacks for empty previews and clamps length", () => {
    expect(buildNotificationBody("", 1).body).toBe("You have a new message.");
    expect(buildNotificationBody("", 5).body).toBe("Tap to open your inbox.");
    expect(buildNotificationBody("x".repeat(300), 2).body).toHaveLength(120);
  });
});

describe("unread delta (§279)", () => {
  it("counts only increases", () => {
    expect(diffNewUnread(2, 5)).toBe(3);
    expect(diffNewUnread(5, 5)).toBe(0);
    expect(diffNewUnread(5, 2)).toBe(0); // read on another device - no alert
  });

  it("ignores non-finite inputs", () => {
    expect(diffNewUnread(Number.NaN, 4)).toBe(0);
    expect(diffNewUnread(1, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("exposes the android channel id", () => {
    expect(CHANNEL_ID).toBe("omniflow-inbox");
  });
});
