import React, { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConversation,
  fetchMessages,
  sendReply,
  type Message,
} from "@/api/portal";
import { formatRelative } from "@/lib/format";
import { Screen } from "@/ui/Screen";
import { Chip, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §277 P2 conversation thread: full CP-backed message history with
 * `before_id` paging, 8s safe polling and human replies (POST queues the
 * reply on the CP exactly like the web portal; handoffs auto-resolve
 * server-side). Optimistic send keeps the UI instant.
 */

function Bubble({ item, now }: { item: Message; now: number }) {
  const { colors, scheme } = useTheme();
  const out = item.direction === "out";
  const sending = item.status === "sending";
  return (
    <View
      style={{
        alignSelf: out ? "flex-end" : "flex-start",
        maxWidth: "82%",
        marginBottom: spacing.sm,
      }}
    >
      <View
        style={{
          borderRadius: 16,
          borderBottomRightRadius: out ? 4 : 16,
          borderBottomLeftRadius: out ? 16 : 4,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          backgroundColor: out ? colors.brand : scheme === "dark" ? colors.surface : colors.brandSoft,
          borderWidth: out ? 0 : 0.5,
          borderColor: colors.line,
          opacity: sending ? 0.65 : 1,
        }}
      >
        <Text
          variant="body"
          tone={out ? "snow" : "ink"}
          style={{ lineHeight: 20 }}
        >
          {item.body}
        </Text>
      </View>
      <Spacer size={2} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          alignSelf: out ? "flex-end" : "flex-start",
        }}
      >
        <Text variant="caption" tone="ink3">
          {item.created_at ? formatRelative(item.created_at, now) : ""}
        </Text>
        {out && !sending ? (
          <Ionicons name="checkmark-done" size={12} color={colors.ok} />
        ) : null}
        {sending ? <Ionicons name="time-outline" size={12} color={colors.ink3} /> : null}
      </View>
    </View>
  );
}

export default function ConversationScreen() {
  const { colors, scheme } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const id = parseInt(String(params.id ?? ""), 10) || 0;
  const [draft, setDraft] = useState("");
  const [older, setOlder] = useState<Message[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);

  const detail = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => fetchConversation(id),
    enabled: id > 0,
    refetchInterval: 30_000,
  });

  const thread = useQuery({
    queryKey: ["messages", id],
    queryFn: () => fetchMessages(id),
    enabled: id > 0,
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
  });

  const messages = useMemo(() => {
    const latest = thread.data?.messages ?? [];
    return [...older, ...latest];
  }, [older, thread.data]);

  // `has_more` only describes the newest page fetch; older pages update it too.
  const showLoadOlder = hasMoreOlder || (older.length === 0 && !!thread.data?.has_more);

  const loadOlder = useCallback(async () => {
    const first = messages[0];
    if (!first?.id) return;
    const page = await fetchMessages(id, first.id).catch(() => null);
    if (!page) return;
    setOlder((prev) => [...page.messages, ...prev]);
    setHasMoreOlder(page.has_more);
  }, [id, messages]);

  const send = useMutation({
    mutationFn: (body: string) => sendReply(id, body),
    onMutate: async (body) => {
      const optimistic: Message = {
        id: "pending-" + Date.now(),
        direction: "out",
        body,
        status: "sending",
        intent: "",
        created_at: new Date().toISOString(),
      };
      queryClient.setQueryData(["messages", id], (prev: unknown) => {
        const data = (prev ?? { messages: [], has_more: false }) as {
          messages: Message[];
          has_more: boolean;
        };
        return { ...data, messages: [...data.messages, optimistic] };
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages", id] });
    },
  });

  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setDraft("");
    send.mutate(body.slice(0, 1000));
  };

  const conversation = detail.data ?? null;
  const title =
    conversation?.contact_name ||
    (typeof params.name === "string" && params.name) ||
    conversation?.contact_id ||
    "Conversation";

  return (
    <Screen scroll={false} keyboard contentStyle={{ padding: 0 }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderBottomWidth: 0.5,
            borderBottomColor: colors.line,
            backgroundColor: scheme === "dark" ? "rgba(13,20,34,0.92)" : "rgba(255,255,255,0.92)",
          }}
        >
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="chevron-back" size={24} color={colors.brand} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text weight="bold" numberOfLines={1}>
              {title}
            </Text>
            <Text variant="caption" tone="ink3" numberOfLines={1}>
              {(conversation?.channel ?? "channel").toString().toUpperCase()}
              {conversation?.status ? " · " + conversation.status : ""}
            </Text>
          </View>
          {conversation?.needs_reply ? (
            <Chip label="Needs reply" color={colors.warn} soft={colors.warnSoft} />
          ) : null}
        </View>

        {/* Thread */}
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id || String(item.created_at) + item.body.slice(0, 8)}
          renderItem={({ item }) => <Bubble item={item} now={Date.now()} />}
          contentContainerStyle={{ padding: spacing.lg, flexGrow: 1 }}
          ListHeaderComponent={
            showLoadOlder ? (
              <Pressable onPress={loadOlder} style={{ alignItems: "center", marginBottom: spacing.md }}>
                <Chip label="Load older messages" color={colors.brand} soft={colors.brandSoft} />
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            thread.isError ? (
              <View style={{ alignItems: "center", gap: spacing.sm, paddingTop: spacing.xl * 2 }}>
                <Text weight="semibold">Could not load this thread</Text>
                <Text variant="caption" tone="ink3">
                  Retrying automatically - pull down or reopen to force it.
                </Text>
              </View>
            ) : (
              <View style={{ alignItems: "center", gap: spacing.sm, paddingTop: spacing.xl * 2 }}>
                <Ionicons name="chatbubble-outline" size={30} color={colors.ink3} />
                <Text variant="caption" tone="ink3">
                  No messages in this conversation yet.
                </Text>
              </View>
            )
          }
        />

        {/* Composer */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            borderTopWidth: 0.5,
            borderTopColor: colors.line,
            backgroundColor: scheme === "dark" ? "rgba(13,20,34,0.92)" : "rgba(255,255,255,0.92)",
          }}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Type a reply…"
            placeholderTextColor={colors.ink3}
            multiline
            maxLength={1000}
            style={{
              flex: 1,
              maxHeight: 96,
              minHeight: 42,
              borderRadius: 21,
              borderWidth: 0.5,
              borderColor: colors.line,
              backgroundColor: colors.surface,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              color: colors.ink,
              fontSize: 15,
            }}
          />
          <Pressable
            onPress={submit}
            disabled={!draft.trim() || send.isPending}
            style={{
              width: 42,
              height: 42,
              borderRadius: 21,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: draft.trim() ? colors.brand : colors.line,
            }}
          >
            <Ionicons
              name={send.isPending ? "hourglass-outline" : "send"}
              size={18}
              color={draft.trim() ? "#ffffff" : colors.ink3}
            />
          </Pressable>
        </View>
        {send.isError ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <Text variant="caption" tone="danger">
              Reply failed - check your connection and try again.
            </Text>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}
