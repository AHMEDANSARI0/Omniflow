import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import Animated, { FadeInDown } from "react-native-reanimated";
import { api } from "@/api/client";
import {
  fetchOperations,
  fetchWhatsappStatus,
  listConversations,
} from "@/api/portal";
import { mobileConfigSchema } from "@/store/app";
import { useAuthStore } from "@/store/auth";
import { appVersion } from "@/config/env";
import { formatPKR, formatRelative } from "@/lib/format";
import { Screen, StatusDot } from "@/ui/Screen";
import { Card, Chip, Divider, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §277 P2 client dashboard: live operations snapshot (chats, messages,
 * orders, recovery, CSAT), WhatsApp channel state and inbox pressure -
 * all from existing CP portal endpoints via safe polling.
 */
export default function HomeScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [days, setDays] = useState(7);

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

  const operations = useQuery({
    queryKey: ["operations", days],
    queryFn: () => fetchOperations(days),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const whatsapp = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: fetchWhatsappStatus,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const inbox = useQuery({
    queryKey: ["conversations", "counts"],
    queryFn: () => listConversations({ limit: 1 }),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const firstName = (user?.name ?? user?.email ?? "").split(/[\s@]/)[0] || "there";
  const ops = operations.data?.operations ?? null;
  const wa = whatsapp.data ?? null;
  const counts = inbox.data?.counts ?? null;
  const waColor =
    wa?.state === "connected" ? colors.ok : wa?.state === "connecting" ? colors.warn : colors.danger;

  const metric = (label: string, value: string, accent?: string) => (
    <Card style={{ flex: 1 }} accent={accent}>
      <Text variant="caption" tone="ink3">
        {label}
      </Text>
      <Spacer size={spacing.xs} />
      <Text variant="title" weight="bold">
        {value}
      </Text>
    </Card>
  );

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

      <Spacer size={spacing.md} />

      <View style={{ flexDirection: "row", gap: spacing.xs }}>
        {[7, 30].map((d) => (
          <Pressable key={d} onPress={() => setDays(d)}>
            <Chip
              label={d === 7 ? "Last 7 days" : "Last 30 days"}
              color={days === d ? colors.brand : colors.ink3}
              soft={days === d ? colors.brandSoft : "transparent"}
            />
          </Pressable>
        ))}
      </View>

      <Spacer size={spacing.md} />

      {/* WhatsApp channel state - tap for details */}
      <Animated.View entering={FadeInDown.duration(400).delay(60)}>
        <Pressable onPress={() => router.push("/activity")}>
          <Card accent={waColor}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <StatusDot color={whatsapp.isLoading ? colors.warn : waColor} />
              <Text weight="semibold" style={{ flex: 1 }}>
                WhatsApp
              </Text>
              <Chip
                label={
                  wa
                    ? wa.state.charAt(0).toUpperCase() + wa.state.slice(1)
                    : "Checking…"
                }
                color={waColor}
                soft={
                  wa?.state === "connected"
                    ? colors.okSoft
                    : wa?.state === "connecting"
                      ? colors.warnSoft
                      : colors.dangerSoft
                }
              />
            </View>
            {wa?.phone || wa?.last_seen_at ? (
              <>
                <Spacer size={spacing.xs} />
                <Text variant="caption" tone="ink3">
                  {wa.phone ? wa.phone + " · " : ""}
                  {wa.last_seen_at
                    ? "Last seen " + formatRelative(wa.last_seen_at)
                    : "Awaiting first status report"}
                </Text>
              </>
            ) : null}
          </Card>
        </Pressable>
      </Animated.View>

      <Spacer size={spacing.md} />

      {/* Inbox pressure */}
      <Animated.View entering={FadeInDown.duration(400).delay(100)}>
        <Pressable onPress={() => router.push("/inbox")}>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Text weight="semibold" style={{ flex: 1 }}>
                Inbox
              </Text>
              {counts && counts.unread > 0 ? (
                <Chip label={`${counts.unread} unread`} color={colors.brand} soft={colors.brandSoft} />
              ) : null}
              {counts && counts.needs_reply > 0 ? (
                <Chip
                  label={`${counts.needs_reply} need reply`}
                  color={colors.warn}
                  soft={colors.warnSoft}
                />
              ) : null}
            </View>
            <Spacer size={spacing.xs} />
            <Text variant="caption" tone="ink3">
              {counts && counts.needs_reply === 0 && counts.unread === 0
                ? "All caught up. Tap to open the unified inbox."
                : "Tap to open the unified inbox."}
            </Text>
          </Card>
        </Pressable>
      </Animated.View>

      <Spacer size={spacing.md} />

      {/* Operations snapshot */}
      <Animated.View entering={FadeInDown.duration(400).delay(140)}>
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {metric(
            `New chats (${days}d)`,
            operations.isLoading && !ops ? "…" : String(ops?.chats.new ?? 0),
            colors.brand,
          )}
          {metric(
            "Open chats",
            operations.isLoading && !ops ? "…" : String(ops?.chats.open ?? 0),
            colors.ai,
          )}
        </View>
        <Spacer size={spacing.sm} />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {metric(
            `Messages in (${days}d)`,
            operations.isLoading && !ops ? "…" : String(ops?.messages.received ?? 0),
          )}
          {metric(
            `Messages out (${days}d)`,
            operations.isLoading && !ops ? "…" : String(ops?.messages.sent ?? 0),
          )}
        </View>
        <Spacer size={spacing.sm} />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {metric(
            `Paid orders (${days}d)`,
            operations.isLoading && !ops ? "…" : String(ops?.orders.paid ?? 0),
            colors.ok,
          )}
          {metric(
            `Revenue (${days}d)`,
            operations.isLoading && !ops ? "…" : formatPKR(ops?.orders.revenue ?? 0),
            colors.ok,
          )}
        </View>
        <Spacer size={spacing.sm} />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {metric(
            "Recovery open",
            operations.isLoading && !ops ? "…" : String(ops?.recovery.open ?? 0),
            colors.warn,
          )}
          {metric(
            `CSAT (${days}d)`,
            operations.isLoading && !ops
              ? "…"
              : ops?.csat.avg_score != null
                ? ops.csat.avg_score.toFixed(2) + " / 5"
                : "—",
          )}
        </View>
      </Animated.View>

      <Spacer size={spacing.md} />

      <Animated.View entering={FadeInDown.duration(400).delay(180)}>
        <Card accent={health.data?.ok ? colors.ok : colors.warn}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <StatusDot
              color={health.isLoading ? colors.warn : health.data?.ok ? colors.ok : colors.danger}
            />
            <Text weight="semibold" style={{ flex: 1 }}>
              Control Plane
            </Text>
            <Chip label={`App v${appVersion}`} color={colors.brand} soft={colors.brandSoft} />
          </View>
          <Spacer size={spacing.xs} />
          <Divider />
          <Spacer size={spacing.xs} />
          <Text variant="caption" tone="ink3">
            {health.isLoading
              ? "Checking connection…"
              : health.data?.ok
                ? "Connected - live API reachable. Data refreshes automatically."
                : "Reachable endpoints are degraded. Showing cached data where available."}
          </Text>
        </Card>
      </Animated.View>
    </Screen>
  );
}
