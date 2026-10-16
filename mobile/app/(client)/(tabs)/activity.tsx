import React from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { fetchOperations, fetchWhatsappStatus } from "@/api/portal";
import { formatCompact, formatRelative } from "@/lib/format";
import { Screen, StatusDot } from "@/ui/Screen";
import { Card, Chip, Divider, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §277 P2 channel activity: live WhatsApp connection state (CP
 * portal_channels.py - the same source the web portal uses) plus today's
 * message flow. Polling every 30s; the CP owns all connector state, the
 * app never touches WhatsApp directly.
 */
export default function ActivityScreen() {
  const { colors } = useTheme();

  const whatsapp = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: fetchWhatsappStatus,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const operations = useQuery({
    queryKey: ["operations", 1],
    queryFn: () => fetchOperations(1),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const wa = whatsapp.data ?? null;
  const state = wa?.state ?? "disconnected";
  const stateColor =
    state === "connected" ? colors.ok : state === "connecting" ? colors.warn : colors.danger;
  const stateSoft =
    state === "connected" ? colors.okSoft : state === "connecting" ? colors.warnSoft : colors.dangerSoft;
  const ops = operations.data?.operations ?? null;

  const detail =
    state === "connected"
      ? "Your WhatsApp number is linked and the assistant is answering customers."
      : state === "connecting"
        ? "Linking in progress - keep the phone online; this resolves on its own."
        : "WhatsApp is not linked right now. Link or re-link the device from the web portal to go live.";

  const row = (label: string, value: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: spacing.sm }}>
      <Text variant="sub" tone="ink3" style={{ flex: 1 }}>
        {label}
      </Text>
      <Text weight="semibold">{value}</Text>
    </View>
  );

  return (
    <Screen>
      <Text variant="display" weight="bold">
        Activity
      </Text>
      <Text variant="sub" tone="ink3">
        Channel health and message flow
      </Text>

      <Spacer size={spacing.lg} />

      <Card accent={whatsapp.isLoading ? colors.warn : stateColor}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <View
            style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              backgroundColor: stateSoft,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="logo-whatsapp" size={24} color={stateColor} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <StatusDot color={whatsapp.isLoading ? colors.warn : stateColor} />
              <Text weight="bold">WhatsApp</Text>
            </View>
            <Text variant="caption" tone="ink3">
              {whatsapp.isLoading
                ? "Checking connection…"
                : state.charAt(0).toUpperCase() + state.slice(1)}
            </Text>
          </View>
          <Chip
            label={state.charAt(0).toUpperCase() + state.slice(1)}
            color={stateColor}
            soft={stateSoft}
          />
        </View>

        <Spacer size={spacing.sm} />
        <Text variant="caption" tone="ink3">
          {detail}
        </Text>

        {wa ? (
          <>
            <Spacer size={spacing.sm} />
            <Divider />
            {row("Account", wa.account_name || "—")}
            <Divider />
            {row("Phone", wa.phone || "—")}
            <Divider />
            {row(
              "Last seen",
              wa.last_seen_at ? formatRelative(wa.last_seen_at) : "Awaiting first report",
            )}
          </>
        ) : null}

        {whatsapp.isError ? (
          <>
            <Spacer size={spacing.sm} />
            <Pressable onPress={() => whatsapp.refetch()}>
              <Chip label="Tap to retry" color={colors.brand} soft={colors.brandSoft} />
            </Pressable>
          </>
        ) : null}
      </Card>

      <Spacer size={spacing.md} />

      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text weight="semibold" style={{ flex: 1 }}>
            Message flow (24h)
          </Text>
          <Chip
            label={`${formatCompact(ops?.messages.received ?? 0)} in · ${formatCompact(
              ops?.messages.sent ?? 0,
            )} out`}
            color={colors.ai}
            soft={colors.aiSoft}
          />
        </View>
        <Spacer size={spacing.xs} />
        <Divider />
        {row("New chats (24h)", String(ops?.chats.new ?? 0))}
        <Divider />
        {row("Open chats", String(ops?.chats.open ?? 0))}
        <Divider />
        {row("Recovery queue open", String(ops?.recovery.open ?? 0))}
      </Card>

      <Spacer size={spacing.md} />
      <Text variant="caption" tone="ink3">
        Workflow runs, approvals and automation events join this screen in the
        next build (P3), streamed from the same CP activity APIs.
      </Text>
    </Screen>
  );
}
