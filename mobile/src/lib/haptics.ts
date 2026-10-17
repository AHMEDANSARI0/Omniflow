/**
 * §279 P4 haptics - one guarded wrapper around expo-haptics. Every call is
 * fire-and-forget, respects the user's preference and never throws (tests,
 * web and older devices degrade silently).
 */

import * as Haptics from "expo-haptics";
import { useSettingsStore } from "@/store/settings";

async function guarded(run: () => Promise<void>): Promise<void> {
  if (!useSettingsStore.getState().prefs.haptics) return;
  try {
    await run();
  } catch {
    // unsupported platform / permission - haptics are cosmetic, fail soft
  }
}

export const haptics = {
  tap: () => guarded(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: () =>
    guarded(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () =>
    guarded(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => guarded(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  selection: () => guarded(() => Haptics.selectionAsync()),
};
