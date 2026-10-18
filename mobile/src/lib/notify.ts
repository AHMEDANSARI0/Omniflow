/**
 * §279b P4 notifications (device side) - LAZY and fail-soft.
 *
 * expo-notifications is imported dynamically: on runtimes where its native
 * module is missing (Expo Go dropped remote push in SDK 53+; older Expo Go
 * clients throw `Cannot find native module 'ExpoTopicSubscriptionModule'`
 * at import time), a top-level import would poison the whole route tree.
 * Lazy loading degrades alerts to "off" while every screen keeps working.
 *
 * Strategy per the locked decision "safe smart polling + push":
 *  - foreground handler shows banners with the user's sound preference;
 *  - inbox polling diffs unread counts and fires a LOCAL notification when
 *    the app is backgrounded (no push infra needed);
 *  - tapping a notification deep-links into the exact conversation;
 *  - Expo Push token registration fails soft until an EAS project id exists.
 */

import { AppState, Platform } from "react-native";
import {
  CHANNEL_ID,
  buildNotificationBody,
  notificationDataSchema,
} from "@/lib/notifyCore";
import { useSettingsStore } from "@/store/settings";
import { logger } from "@/lib/logger";

type NotificationsModule = typeof import("expo-notifications");

// undefined = not attempted yet; null = unavailable on this runtime
let cached: NotificationsModule | null | undefined;

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (cached !== undefined) return cached;
  // §279c: on Android, probe the native module that expo-notifications
  // eagerly requires during import. Older Expo Go clients lack it and
  // merely evaluating the module logs a scary global ERROR; when the probe
  // says "absent" we skip the import entirely (alerts off, fail soft).
  if (Platform.OS === "android") {
    try {
      const core = await import("expo-modules-core");
      if (!core.requireOptionalNativeModule("ExpoTopicSubscriptionModule")) {
        logger.warn(
          "expo-notifications unsupported on this runtime - alerts off (update Expo Go)",
        );
        cached = null;
        return cached;
      }
    } catch {
      // probe itself unavailable - fall through and attempt the real import
    }
  }
  try {
    cached = await import("expo-notifications");
  } catch (err) {
    logger.warn("expo-notifications unavailable - alerts disabled", err);
    cached = null;
  }
  return cached;
}

type Navigator = (href: string) => void;

let navigator: Navigator | null = null;

/** Wired by the root layout once expo-router is mounted. */
export function setNotificationNavigator(fn: Navigator | null): void {
  navigator = fn;
}

export async function initNotifications(): Promise<void> {
  try {
    const N = await loadNotifications();
    if (!N) return;

    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: useSettingsStore.getState().prefs.sounds,
        shouldSetBadge: true,
      }),
    });

    if (Platform.OS === "android") {
      await N.setNotificationChannelAsync(CHANNEL_ID, {
        name: "Inbox alerts",
        importance: N.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#4f46e5",
      });
    }

    const status = await N.getPermissionsAsync();
    if (!status.granted) {
      const asked = await N.requestPermissionsAsync();
      if (!asked.granted) logger.warn("notification permission denied");
    }

    N.addNotificationResponseReceivedListener((response) => {
      const data = notificationDataSchema.parse(
        response.notification.request.content.data ?? {},
      );
      if (!navigator) return;
      if (data.conversationId) navigator(`/conversation/${data.conversationId}`);
      else if (data.tab) navigator(`/${data.tab}`);
      else navigator("/inbox");
    });
  } catch (err) {
    logger.warn("notifications init failed soft", err);
  }
}

/**
 * Fires a local notification for newly arrived messages - only while the
 * app is NOT in the foreground (in-app the badge + list update is enough)
 * and only when the user enabled alerts and the runtime supports them.
 */
export async function notifyNewMessages(
  preview: string,
  count: number,
  conversationId?: number | string | null,
): Promise<void> {
  try {
    const { prefs } = useSettingsStore.getState();
    if (!prefs.notifications) return;
    if (AppState.currentState === "active") return;
    const N = await loadNotifications();
    if (!N) return;
    const { title, body } = buildNotificationBody(preview, count);
    await N.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: prefs.sounds ? "default" : undefined,
        data: { conversationId: conversationId ?? null, tab: "inbox" },
      },
      trigger: null, // deliver immediately
    });
  } catch (err) {
    logger.warn("local notification failed soft", err);
  }
}

/** Expo Push token - null until an EAS project id exists (fail soft). */
export async function registerForPush(): Promise<string | null> {
  try {
    const N = await loadNotifications();
    if (!N) return null;
    const token = await N.getExpoPushTokenAsync();
    return token.data || null;
  } catch {
    return null;
  }
}
