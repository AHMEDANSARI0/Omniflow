import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import Animated, { FadeInDown } from "react-native-reanimated";
import {
  fetchAdminOverview,
  fetchAdminQuality,
  fetchAdminSiteStats,
} from "@/api/admin";
import { useAuthStore } from "@/store/auth";
import { appVersion } from "@/config/env";
import { Screen, StatusDot } from "@/ui/Screen";
import { Card, Chip, Spacer, Text } from "@/ui/primitives";
import { formatCompact } from "@/lib/format";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §280 P5 admin overview: platform health (P1) + live AI engine and website
 * analytics summaries - all through session-guarded CP mobile-admin routes
 * that reuse the web admin's own data sources. Tap a card for the full
 * analytics screen.
 */
export default function AdminOverview() {
  const { colors } = useTheme();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: fetchAdminOverview,
    staleTime: 30_000,
  });

  const quality = useQuery({
    queryKey: ["admin-quality", 7],
    queryFn: () => fetchAdminQuality(7),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const site = useQuery({
    queryKey: ["admin-site-stats", 7],
    queryFn: () => fetchAdminSiteStats(7),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const dbHealthy = overview.data?.database === true;
  const totals = ((quality.data?.overview?.totals ?? {}) as Record<string, unknown>);
  const controls = ((quality.data?.overview?.controls ?? {}) as Record<string, unknown>);
  const answers = Number(totals.answers ?? 0) || 0;
  const handoffs = Number(totals.handoffs ?? 0) || 0;
  const blocked = Number(totals.blocked ?? 0) || 0;
  const killSwitch = controls.kill_switch === true;
  const siteTotals = site.data?.stats?.totals ?? null;

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
            <Text weight="semibold" style={{ flex: 1 }}>
              Control Plane
            </Text>
            <Chip label={`Guard v${appVersion}`} color={colors.brand} soft={colors.brandSoft} />
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

      <Animated.View entering={FadeInDown.duration(400).delay(120)}>
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <Card style={{ flex: 1 }}>
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
          </Card>
          <Card style={{ flex: 1 }}>
            <Text variant="caption" weight="semibold" tone="ink3">
              AI ANSWERS (7D)
            </Text>
            <Spacer size={spacing.xxs} />
            <Text variant="hero" weight="bold">
              {quality.isLoading && !quality.data ? "…" : formatCompact(answers)}
            </Text>
          </Card>
        </View>
      </Animated.View>

      <Spacer size={spacing.md} />

      {/* §280: AI engine summary - tap for the full analytics screen */}
      <Animated.View entering={FadeInDown.duration(400).delay(160)}>
        <Pressable onPress={() => router.push("/analytics")}>
          <Card accent={killSwitch ? colors.danger : colors.ai}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <StatusDot color={killSwitch ? colors.danger : colors.ai} />
              <Text weight="semibold" style={{ flex: 1 }}>
                AI engine
              </Text>
              {killSwitch ? (
                <Chip label="Kill switch ON" color={colors.danger} soft={colors.dangerSoft} />
              ) : (
                <Chip
                  label={String(controls.autonomy_cap ?? "auto")}
                  color={colors.ai}
                  soft={colors.aiSoft}
                />
              )}
            </View>
            <Spacer size={spacing.xs} />
            <Text variant="caption" tone="ink3">
              {quality.data?.degraded
                ? "Quality data degraded - CP database busy or unreachable."
                : `${formatCompact(handoffs)} handoffs · ${formatCompact(blocked)} blocked (7d)`}
            </Text>
          </Card>
        </Pressable>
      </Animated.View>

      <Spacer size={spacing.md} />

      {/* §280: website analytics summary - tap for the full screen */}
      <Animated.View entering={FadeInDown.duration(400).delay(200)}>
        <Pressable onPress={() => router.push("/analytics")}>
          <Card accent={colors.brand}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <StatusDot color={site.data?.stats ? colors.ok : colors.warn} />
              <Text weight="semibold" style={{ flex: 1 }}>
                Website (7d)
              </Text>
              <Chip
                label={`${formatCompact(siteTotals?.views ?? 0)} views`}
                color={colors.brand}
                soft={colors.brandSoft}
              />
            </View>
            <Spacer size={spacing.xs} />
            <Text variant="caption" tone="ink3">
              {site.data?.degraded
                ? "Site stats degraded right now."
                : `${formatCompact(siteTotals?.visitors ?? 0)} visitors · ${formatCompact(
                  siteTotals?.form_submits ?? 0,
                )} form submits · ${formatCompact(siteTotals?.cta_clicks ?? 0)} CTA clicks`}
            </Text>
          </Card>
        </Pressable>
      </Animated.View>

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
