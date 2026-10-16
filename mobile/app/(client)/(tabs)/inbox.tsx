import React, { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { listConversations, type Conversation } from "@/api/portal";
import { formatRelative } from "@/lib/format";
import { Screen, StatusDot } from "@/ui/Screen";
import { Button } from "@/ui/Button";
import { Chip, Divider, Spacer, Text } from "@/ui/primitives";
import { TextField } from "@/ui/TextField";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §277 P2 unified inbox: every channel (WhatsApp, email, SMS, social…) in
 * one CP-backed list with search, status filters, unread/needs-reply
 * badges and safe 20s polling while the tab is open.
 */

type StatusFilter = "all" | "open" | "closed";

function channelIcon(channel: string): keyof typeof Ionicons.glyphMap {
  const c = channel.toLowerCase();
  if (c.includes("whatsapp")) return "logo-whatsapp";
  if (c.includes("email")) return "mail-outline";
  if (c.includes("sms")) return "chatbox-ellipses-outline";
  if (c.includes("instagram")) return "logo-instagram";
  if (c.includes("facebook") || c.includes("messenger")) return "logo-facebook";
  if (c.includes("telegram")) return "send-outline";
  return "chatbubble-ellipses-outline";
}

function ConversationRow({
  item,
  onPress,
}: {
  item: Conversation;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const initial = (item.contact_name || item.contact_id || "?").charAt(0).toUpperCase();
  return (
    <Pressable onPress={onPress} style={{ paddingVertical: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: colors.brandSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text weight="bold" tone="brand">
            {initial}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons
              name={channelIcon(item.channel)}
              size={14}
              color={colors.ok}
            />
            <Text weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
              {item.contact_name || item.contact_id || "Unknown contact"}
            </Text>
            {item.starred ? (
              <Ionicons name="star" size={13} color={colors.warn} />
            ) : null}
            <Text variant="caption" tone="ink3">
              {item.last_message_at ? formatRelative(item.last_message_at) : ""}
            </Text>
          </View>
          <Spacer size={2} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Text
              variant="caption"
              tone={item.unread ? "ink" : "ink3"}
              weight={item.unread ? "semibold" : "normal"}
              numberOfLines={1}
              style={{ flex: 1 }}
            >
              {item.last_message_preview || "No messages yet"}
            </Text>
            {item.unread ? <StatusDot color={colors.brand} /> : null}
            {item.needs_reply ? (
              <Chip label="Reply" color={colors.warn} soft={colors.warnSoft} />
            ) : null}
          </View>
        </View>
      </View>
      <Spacer size={spacing.sm} />
      <Divider />
    </Pressable>
  );
}

export default function InboxScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const inbox = useQuery({
    queryKey: ["conversations", status, debounced],
    queryFn: () => listConversations({ status, q: debounced || undefined }),
    refetchInterval: 20_000,
    placeholderData: (prev) => prev,
  });

  const conversations = useMemo(
    () => inbox.data?.conversations ?? [],
    [inbox.data],
  );
  const counts = inbox.data?.counts ?? null;

  const filters: Array<{ key: StatusFilter; label: string }> = [
    { key: "all", label: counts ? `All` : "All" },
    { key: "open", label: "Open" },
    { key: "closed", label: "Closed" },
  ];

  return (
    <Screen scroll={false}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="display" weight="bold" style={{ flex: 1 }}>
          Inbox
        </Text>
        {counts && counts.unread > 0 ? (
          <Chip label={`${counts.unread} unread`} color={colors.brand} soft={colors.brandSoft} />
        ) : null}
      </View>
      <Spacer size={spacing.sm} />

      <TextField
        label="Search"
        value={search}
        onChangeText={setSearch}
        placeholder="Search name, number or message…"
        autoCorrect={false}
        returnKeyType="search"
      />
      <Spacer size={spacing.sm} />

      <View style={{ flexDirection: "row", gap: spacing.xs }}>
        {filters.map((f) => (
          <Pressable key={f.key} onPress={() => setStatus(f.key)}>
            <Chip
              label={f.label}
              color={status === f.key ? colors.brand : colors.ink3}
              soft={status === f.key ? colors.brandSoft : "transparent"}
            />
          </Pressable>
        ))}
      </View>

      <Spacer size={spacing.sm} />

      <FlatList
        data={conversations}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <ConversationRow
            item={item}
            onPress={() =>
              router.push({
                pathname: "/conversation/[id]",
                params: { id: String(item.id), name: item.contact_name || item.contact_id },
              })
            }
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={inbox.isRefetching && !inbox.isFetching}
            onRefresh={() => inbox.refetch()}
            tintColor={colors.brand}
          />
        }
        ListEmptyComponent={
          <View style={{ paddingVertical: spacing.xl * 2, alignItems: "center", gap: spacing.sm }}>
            {inbox.isError ? (
              <>
                <Text weight="semibold">Could not reach the Control Plane</Text>
                <Text variant="caption" tone="ink3" style={{ textAlign: "center" }}>
                  Check your connection - the inbox retries automatically.
                </Text>
                <Button title="Retry now" onPress={() => inbox.refetch()} />
              </>
            ) : (
              <>
                <Ionicons name="chatbubbles-outline" size={34} color={colors.ink3} />
                <Text weight="semibold">
                  {debounced ? "No matches" : "No conversations yet"}
                </Text>
                <Text variant="caption" tone="ink3" style={{ textAlign: "center" }}>
                  {debounced
                    ? "Try a different name, number or keyword."
                    : "When customers message your channels, every thread lands here."}
                </Text>
              </>
            )}
          </View>
        }
      />
    </Screen>
  );
}
