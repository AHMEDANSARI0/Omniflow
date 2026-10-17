/**
 * §279 P4 notification core - PURE logic (no native imports) so it is fully
 * unit-testable: preference schema, notification payload parsing, message
 * copy builder and the unread-delta rule that decides when a local alert
 * fires. Side effects live in src/lib/notify.ts.
 */

import { z } from "zod";

export const CHANNEL_ID = "omniflow-inbox";

export const notificationPrefsSchema = z.object({
  notifications: z.boolean().catch(true),
  sounds: z.boolean().catch(true),
  haptics: z.boolean().catch(true),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const DEFAULT_PREFS: NotificationPrefs = {
  notifications: true,
  sounds: true,
  haptics: true,
};

/** Payload we attach to every local notification for deep-link routing. */
export const notificationDataSchema = z.object({
  conversationId: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : String(v)))
    .catch(null),
  tab: z
    .string()
    .nullish()
    .transform((v) => (typeof v === "string" ? v : ""))
    .catch(""),
});
export type NotificationData = z.infer<typeof notificationDataSchema>;

export function buildNotificationBody(
  preview: string,
  count: number,
): { title: string; body: string } {
  const clean = String(preview || "").trim().slice(0, 120);
  const n = Math.max(1, Math.floor(count) || 1);
  if (n <= 1) {
    return { title: "New message", body: clean || "You have a new message." };
  }
  return {
    title: `${n} new messages`,
    body: clean || "Tap to open your inbox.",
  };
}

/** How many NEW unread items appeared since the last poll (never negative). */
export function diffNewUnread(prevUnread: number, nextUnread: number): number {
  if (!Number.isFinite(prevUnread) || !Number.isFinite(nextUnread)) return 0;
  const delta = nextUnread - prevUnread;
  return delta > 0 ? delta : 0;
}
