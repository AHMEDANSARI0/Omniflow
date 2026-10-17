/**
 * §279 P4 notifications (device side). Strategy per the locked decision
 * "safe smart polling + push":
 *  - a foreground handler shows banners with the user's sound preference;
 *  - inbox polling diffs unread counts and fires a LOCAL notification when
 *    the app is backgrounded (no push infra needed, works in Expo Go);
 *  - tapping a notification deep-links into the exact conversation;
 *  - Expo Push token registration is attempted but fails SOFT until the
 *    EAS project id exists (server-side push lands with the EAS account).
 */

import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import {
  CHANNEL_ID,
  buildNotificationBody,
  notificationDataSchema,
} from "@/lib/notifyCore";
import { useSettingsStore } from "@/store/settings";
import { logger } from "@/lib/logger";

type Navigator = (href: string) => void;

let navigator: Navigator | null = null;

/** Wired by the root layout once expo-router is mounted. */
export function setNotificationNavigator(fn: Navigator | null): void {
  navigator = fn;
}

export async function initNotifications(): Promise<void> {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: useSettingsStore.getState().prefs.sounds,
        shouldSetBadge: true,
      }),
    });

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: "Inbox alerts",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#4f46e5",
      });
    }

    const status = await Notifications.getPermissionsAsync();
    if (!status.granted) {
      const asked = await Notifications.requestPermissionsAsync();
      if (!asked.granted) logger.warn("notification permission denied");
    }

    Notifications.addNotificationResponseReceivedListener((response) => {
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
 * and only when the user enabled alerts.
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
    const { title, body } = buildNotificationBody(preview, count);
    await Notifications.scheduleNotificationAsync({
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
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data || null;
  } catch {
    return null;
  }
}
