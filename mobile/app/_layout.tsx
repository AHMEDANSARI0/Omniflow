import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, useTheme } from "@/ui/theme";
import { createQueryClient } from "@/api/queryClient";
import { useAuthStore, fingerprintForUser } from "@/store/auth";
import { updateGate, useAppStore } from "@/store/app";
import { useSettingsStore } from "@/store/settings";
import { initNotifications, setNotificationNavigator } from "@/lib/notify";
import { checkForUpdatesNow, checkForUpdatesSilently } from "@/lib/updates";
import {
  loadSnapshot,
  seedQueryClient,
  startCachePersistence,
} from "@/lib/offlineCache";
import { appVersion } from "@/config/env";
import { logger } from "@/lib/logger";
import { Button } from "@/ui/Button";
import { Card, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { ErrorBoundary } from "@/ui/ErrorBoundary";
import { OfflineBanner } from "@/ui/OfflineBanner";
import { UpdateBanner } from "@/ui/UpdateBanner";

SplashScreen.preventAutoHideAsync().catch(() => {
  // reloading or dev-server quirks may reject - safe to ignore
});

const queryClient = createQueryClient();

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  // §281: version/maintenance gate - config comes from the CP (/mobile/config)
  // and is compared against this build's version. Pure logic, unit-tested.
  const config = useAppStore((s) => s.config);
  const gate = updateGate(config, appVersion);

  useEffect(() => {
    let cancelled = false;
    let loadedFingerprint: string | null = null;
    (async () => {
      try {
        // §281: seed the offline snapshot BEFORE first paint so a cold start
        // (even with no network) shows the last known data immediately. The
        // entries are invalidated right away - online, they refetch and
        // replace themselves; offline, the cached data stays on screen.
        const cached = await loadSnapshot();
        if (cached && !cancelled) {
          loadedFingerprint = cached.fingerprint;
          const seeded = seedQueryClient(queryClient, cached.snapshot);
          if (seeded > 0) logger.log("offline cache seeded", { entries: seeded });
        }
      } catch {
        // the cache must never block boot
      }
      try {
        await Promise.all([
          useAuthStore.getState().hydrate(),
          useAppStore.getState().loadConfig(),
          // §279 P4: local settings + notification plumbing boot with the app
          useSettingsStore.getState().hydrate(),
          initNotifications(),
        ]);
        // §282i: if the seeded snapshot belongs to a different session,
        // clear it so the current user never sees another account's data.
        if (!cancelled && loadedFingerprint) {
          const state = useAuthStore.getState();
          if (state.status === "authenticated" && state.user) {
            const expected = fingerprintForUser(state.user);
            if (loadedFingerprint !== expected) {
              queryClient.clear();
              logger.log("offline cache cleared: session fingerprint mismatch");
            }
          }
        }
      } catch (err) {
        logger.warn("boot failed soft", err);
      } finally {
        if (!cancelled) setReady(true);
        setNotificationNavigator((href) => router.push(href as never));
        /* update availability check moved to UpdateBanner (user-facing notification) */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // §281: keep the offline snapshot fresh - every cache change schedules a
  // debounced persist (bounded entries, fail-soft writes).
  useEffect(() => {
    if (!ready) return;
    const stop = startCachePersistence(queryClient);
    return stop;
  }, [ready]);

  if (!ready) return null;

  // §281: maintenance / forced-update screens replace the whole navigator.
  if (gate !== "ok") {
    return (
      <ThemeProvider>
        <GateScreen gate={gate} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <View style={{ flex: 1 }}>
            <StatusBar style="auto" />
            <OfflineBanner />
          <UpdateBanner />
            <Stack
              screenOptions={{ headerShown: false, animation: "fade" }}
            >
              <Stack.Screen name="index" />
              <Stack.Screen name="login" />
              <Stack.Screen name="(client)" />
              <Stack.Screen name="(admin)" />
            </Stack>
          </View>
        </ErrorBoundary>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

/** §281: full-screen states for the maintenance and forced-update gates. */
function GateScreen({ gate }: { gate: "maintenance" | "update_required" }) {
  const { colors } = useTheme();
  const maintenance = gate === "maintenance";
  return (
    <View style={{ flex: 1, padding: spacing.lg, justifyContent: "center" }}>
      <Card accent={maintenance ? colors.warn : colors.danger}>
        <Text weight="bold" style={{ fontSize: 17 }}>
          {maintenance ? "OmniFlow is under maintenance" : "Update required"}
        </Text>
        <Spacer size={spacing.sm} />
        <Text variant="caption" tone="ink3">
          {maintenance
            ? "We're making things better right now. Please check back in a bit."
            : "This version of the app is no longer supported. Install the latest update to continue."}
        </Text>
        <Spacer size={spacing.md} />
        <Button
          title={maintenance ? "Try again" : "Check for updates"}
          onPress={() => {
            void useAppStore.getState().loadConfig();
            void checkForUpdatesNow();
          }}
        />
      </Card>
    </View>
  );
}