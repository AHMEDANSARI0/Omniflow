import React, { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/ui/theme";
import { createQueryClient } from "@/api/queryClient";
import { useAuthStore } from "@/store/auth";
import { useAppStore } from "@/store/app";
import { checkForUpdatesSilently } from "@/lib/updates";
import { logger } from "@/lib/logger";

SplashScreen.preventAutoHideAsync().catch(() => {
  // reloading or dev-server quirks may reject - safe to ignore
});

const queryClient = createQueryClient();

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await Promise.all([
          useAuthStore.getState().hydrate(),
          useAppStore.getState().loadConfig(),
        ]);
      } catch (err) {
        logger.warn("boot failed soft", err);
      } finally {
        if (!cancelled) setReady(true);
        void checkForUpdatesSilently();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{ headerShown: false, animation: "fade" }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="login" />
          <Stack.Screen name="(client)" />
          <Stack.Screen name="(admin)" />
        </Stack>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
