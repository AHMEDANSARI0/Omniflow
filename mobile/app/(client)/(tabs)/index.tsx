import React from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { api } from "@/api/client";
import { mobileConfigSchema } from "@/store/app";
import { useAuthStore } from "@/store/auth";
import { appVersion } from "@/config/env";
import { Screen, StatusDot } from "@/ui/Screen";
import { Card, Chip, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * P0 Home: proves the full stack end-to-end (auth -> query -> CP -> UI).
 * The rich dashboard (metrics, WhatsApp status, AI activity) lands in P2
 * on top of exactly these primitives.
 */
export default function HomeScreen() {
  const { colors } = useTheme();
  const user = useAuthStore((s) => s.user);

  const health = useQuery({
    queryKey: ["mobile-config"],
    queryFn: async () => {
      try {
        const data = await api.get<unknown>("/api/v1/mobile/config", {
          auth: false,
          timeoutMs: 8_000,
          retries: 0,
        });
        return { ok: true, config: mobileConfigSchema.safeParse(data ?? {}).data };
      } catch {
        return { ok: false as const };
      }
    },
    staleTime: 60_000,
  });

  const firstName = (user?.name ?? user?.email ?? "").split(/[\s@]/)[0] || "there";

  return (
    <Screen>
      <Animated.View entering={FadeInDown.duration(400)}>
        <Text variant="caption" weight="semibold" tone="brand">
          OMNIFLOW
        </Text>
        <Text variant="display" weight="bold">
          Welcome back, {firstName}
        </Text>
        <Text variant="sub" tone="ink3">
          {user?.business_name ?? "Your automation cockpit"}
        </Text>
      </Animated.View>

      <Spacer size={spacing.xl} />

      <Animated.View entering={FadeInDown.duration(400).delay(80)}>
        <Card accent={health.data?.ok ? colors.ok : colors.warn}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <StatusDot color={health.isLoading ? colors.warn : health.data?.ok ? colors.ok : colors.danger} />
            <Text weight="semibold">Control Plane</Text>
          </View>
          <Spacer size={spacing.xs} />
          <Text variant="caption" tone="ink3">
            {health.isLoading
              ? "Checking connection…"
              : health.data?.ok
                ? "Connected - live API reachable."
                : "Reachable endpoints are degraded. Showing cached data where available."}
          </Text>
        </Card>
      </Animated.View>

      <Spacer size={spacing.md} />

      <Card>
        <Text weight="semibold">Foundation ready</Text>
        <Spacer size={spacing.xs} />
        <Text variant="caption" tone="ink3">
          Inbox, WhatsApp status, workflows and analytics attach in the next
          build (P2) - this screen becomes the live dashboard without changing
          anything below it.
        </Text>
        <Spacer size={spacing.sm} />
        <View style={{ flexDirection: "row", gap: spacing.xs }}>
          <Chip label={`App v${appVersion}`} color={colors.brand} soft={colors.brandSoft} />
          <Chip label="P0 foundation" color={colors.ai} soft={colors.aiSoft} />
        </View>
      </Card>
    </Screen>
  );
}
