/**
 * §279b P4 haptics - lazy, guarded wrapper around expo-haptics. Dynamic
 * import keeps runtimes without the native module alive (same fail-soft
 * law as notify.ts); every call respects the user's preference and never
 * throws. Haptics are cosmetic - the app must never depend on them.
 */

import { useSettingsStore } from "@/store/settings";

type HapticsModule = typeof import("expo-haptics");

let cached: HapticsModule | null | undefined;

async function loadHaptics(): Promise<HapticsModule | null> {
  if (cached !== undefined) return cached;
  try {
    cached = await import("expo-haptics");
  } catch {
    cached = null;
  }
  return cached;
}

async function guarded(run: (H: HapticsModule) => Promise<void>): Promise<void> {
  if (!useSettingsStore.getState().prefs.haptics) return;
  try {
    const H = await loadHaptics();
    if (H) await run(H);
  } catch {
    // unsupported platform / permission - haptics are cosmetic, fail soft
  }
}

export const haptics = {
  tap: () => guarded((H) => H.impactAsync(H.ImpactFeedbackStyle.Light)),
  success: () =>
    guarded((H) => H.notificationAsync(H.NotificationFeedbackType.Success)),
  warning: () =>
    guarded((H) => H.notificationAsync(H.NotificationFeedbackType.Warning)),
  error: () => guarded((H) => H.notificationAsync(H.NotificationFeedbackType.Error)),
  selection: () => guarded((H) => H.selectionAsync()),
};
