/**
 * §279 P4 local settings store: notification / sound / haptic preferences,
 * persisted with AsyncStorage (non-sensitive, so no SecureStore). Hydrated
 * at boot by the root layout; every toggle writes through immediately.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import {
  DEFAULT_PREFS,
  notificationPrefsSchema,
  type NotificationPrefs,
} from "@/lib/notifyCore";
import { logger } from "@/lib/logger";

const KEY = "omniflow.settings.v1";

interface SettingsState {
  prefs: NotificationPrefs;
  loaded: boolean;
  hydrate: () => Promise<void>;
  update: (patch: Partial<NotificationPrefs>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  prefs: DEFAULT_PREFS,
  loaded: false,

  async hydrate() {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        const parsed = notificationPrefsSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          set({ prefs: parsed.data, loaded: true });
          return;
        }
      }
      set({ loaded: true });
    } catch (err) {
      logger.warn("settings hydrate failed soft", err);
      set({ loaded: true });
    }
  },

  async update(patch) {
    const next = { ...get().prefs, ...patch };
    set({ prefs: next });
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch (err) {
      logger.warn("settings persist failed soft", err);
    }
  },
}));
