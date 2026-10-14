import React from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { fetchAdminOverview } from "@/api/admin";
import { useAuthStore } from "@/store/auth";
import { appVersion } from "@/config/env";
import { Screen, StatusDot } from "@/ui/Screen";
import { Card, Chip, Spacer, Text } from "@/ui/primitives";
import { formatCompact } from "@/lib/format";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/** §272 Admin overview - live CP data through the mobile-admin guard. */
export default function AdminOverview() {
  const { colors } = useTheme();
  const user = useAuthStore((s) => s.user);

  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: fetchAdminOverview,
    staleTime: 30_000,
  });

  const dbHealthy = overview.data?.database === true;

  return (
    <Screen>
      <Animated.View entering={FadeInDown.duration(400)}>
        <Text variant="caption" weight="semibold" tone="brand">
          OMNIFLOW ADMIN
        </Text>
        <Text variant="display" weight="bold">
          Platform overview
        </Text>
        <Text variant="sub" tone="ink3">
          Signed in as {user?.email ?? "owner"}
        </Text>
      </Animated.View>

      <Spacer size={spacing.xl} />

      <Animated.View entering={FadeInDown.duration(400).delay(80)}>
        <Card accent={dbHealthy ? colors.ok : colors.warn}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <StatusDot color={overview.isLoading ? colors.warn : dbHealthy ? colors.ok : colors.danger} />
            <Text weight="semibold">Control Plane</Text>
          </View>
          <Spacer size={spacing.xs} />
          <Text variant="caption" tone="ink3">
            {overview.isLoading
              ? "Checking platform health…"
              : dbHealthy
                ? "Database connected - admin guard active."
                : "Database unreachable from the Control Plane right now."}
          </Text>
        </Card>
      </Animated.View>

      <Spacer size={spacing.md} />

      <Card>
        <Text variant="caption" weight="semibold" tone="ink3">
          PLATFORM USERS
        </Text>
        <Spacer size={spacing.xxs} />
        <Text variant="hero" weight="bold">
          {overview.isLoading
            ? "…"
            : overview.data?.platform_users == null
              ? "—"
              : formatCompact(overview.data.platform_users)}
        </Text>
        <Spacer size={spacing.sm} />
        <View style={{ flexDirection: "row", gap: spacing.xs }}>
          <Chip label={`Guard v${appVersion}`} color={colors.brand} soft={colors.brandSoft} />
          <Chip label="Read-only (P1)" color={colors.ai} soft={colors.aiSoft} />
        </View>
      </Card>

      {overview.isError ? (
        <>
          <Spacer size={spacing.md} />
          <Card accent={colors.danger}>
            <Text variant="caption" tone="danger">
              Overview could not be loaded. Make sure you signed in with an
              admin account created via the Control Plane bootstrap step.
            </Text>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
