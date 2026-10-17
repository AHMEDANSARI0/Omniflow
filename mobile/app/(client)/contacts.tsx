import React, { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { listCustomers, type Customer } from "@/api/customers";
import { formatRelative } from "@/lib/format";
import { Screen } from "@/ui/Screen";
import { Button } from "@/ui/Button";
import { Chip, Divider, Spacer, Text } from "@/ui/primitives";
import { TextField } from "@/ui/TextField";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §278 P3 contacts: every customer across channels, from the CP's
 * /portal/customers endpoint (search debounced, 30s safe polling,
 * pull-to-refresh). Lead temperature drives the chip colour.
 */

function tempColors(temp: Customer["lead_temp"]) {
  const { colors } = useTheme();
  if (temp === "hot") return { color: colors.danger, soft: colors.dangerSoft };
  if (temp === "warm") return { color: colors.warn, soft: colors.warnSoft };
  return { color: colors.ink3, soft: "transparent" };
}

function CustomerRow({ item }: { item: Customer }) {
  const { colors } = useTheme();
  const temp = tempColors(item.lead_temp);
  const initial = (item.name || item.contact_id || "?").charAt(0).toUpperCase();
  return (
    <View style={{ paddingVertical: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
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
            <Text weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
              {item.name || item.contact_id || "Unknown contact"}
            </Text>
            <Chip
              label={item.lead_temp}
              color={temp.color}
              soft={temp.soft || colors.brandSoft}
            />
          </View>
          <Spacer size={2} />
          <Text variant="caption" tone="ink3" numberOfLines={1}>
            {item.channels.length > 0 ? item.channels.join(" · ") + " · " : ""}
            {item.conversation_count} chat{item.conversation_count === 1 ? "" : "s"}
            {item.last_message_at ? " · " + formatRelative(item.last_message_at) : ""}
          </Text>
          {item.last_message_preview ? (
            <Text variant="caption" tone="ink3" numberOfLines={1}>
              “{item.last_message_preview}”
            </Text>
          ) : null}
        </View>
      </View>
      <Spacer size={spacing.sm} />
      <Divider />
    </View>
  );
}

export default function ContactsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const contacts = useQuery({
    queryKey: ["customers", debounced],
    queryFn: () => listCustomers(debounced),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const customers = useMemo(
    () => contacts.data?.customers ?? [],
    [contacts.data],
  );

  return (
    <Screen scroll={false}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.brand} />
        </Pressable>
        <Text variant="display" weight="bold" style={{ flex: 1 }}>
          Contacts
        </Text>
        <Chip label={`${customers.length}`} color={colors.brand} soft={colors.brandSoft} />
      </View>
      <Spacer size={spacing.sm} />

      <TextField
        label="Search"
        value={search}
        onChangeText={setSearch}
        placeholder="Name or number…"
        autoCorrect={false}
        returnKeyType="search"
      />

      <FlatList
        data={customers}
        keyExtractor={(item) => item.contact_id}
        renderItem={({ item }) => <CustomerRow item={item} />}
        refreshControl={
          <RefreshControl
            refreshing={contacts.isRefetching && !contacts.isFetching}
            onRefresh={() => contacts.refetch()}
            tintColor={colors.brand}
          />
        }
        ListEmptyComponent={
          <View style={{ paddingVertical: spacing.xl * 2, alignItems: "center", gap: spacing.sm }}>
            {contacts.isError ? (
              <>
                <Text weight="semibold">Could not reach the Control Plane</Text>
                <Button title="Retry now" onPress={() => contacts.refetch()} />
              </>
            ) : (
              <>
                <Ionicons name="people-outline" size={34} color={colors.ink3} />
                <Text weight="semibold">
                  {debounced ? "No matches" : "No contacts yet"}
                </Text>
                <Text variant="caption" tone="ink3" style={{ textAlign: "center" }}>
                  {debounced
                    ? "Try a different name or number."
                    : "Customers appear here automatically after their first conversation."}
                </Text>
              </>
            )}
          </View>
        }
      />
    </Screen>
  );
}
