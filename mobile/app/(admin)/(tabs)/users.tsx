import React from "react";
import { FlatList, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminUsers, type AdminUser } from "@/api/admin";
import { Screen } from "@/ui/Screen";
import { Card, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/** §272 Client accounts list (read-only in P1). */
export default function AdminUsers() {
  const { colors } = useTheme();
  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: fetchAdminUsers,
    staleTime: 30_000,
  });

  return (
    <Screen scroll={false} contentStyle={{ paddingBottom: 0 }}>
      <Text variant="display" weight="bold">
        Clients
      </Text>
      <Text variant="caption" tone="ink3">
        {users.data ? `${users.data.count} platform accounts` : " "}
      </Text>
      <Spacer size={spacing.md} />
      {users.isLoading ? (
        <Text tone="ink3">Loading accounts…</Text>
      ) : users.isError ? (
        <Text tone="danger">The client list is unavailable right now.</Text>
      ) : (
        <FlatList
          data={users.data?.users ?? []}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <UserRow user={item} />}
          ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
          contentContainerStyle={{ paddingBottom: spacing.xl }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<Text tone="ink3">No client accounts yet.</Text>}
        />
      )}
    </Screen>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const { colors } = useTheme();
  return (
    <Card style={{ paddingVertical: spacing.md }}>
      <Text weight="semibold" numberOfLines={1}>
        {user.email ?? `Account ${user.id}`}
      </Text>
      <Text variant="caption" tone="ink3">
        id {String(user.id)}
      </Text>
      <View
        style={{
          position: "absolute",
          right: spacing.lg,
          top: spacing.md,
          bottom: spacing.md,
          width: 4,
          borderRadius: 2,
          backgroundColor: colors.brandSoft,
        }}
      />
    </Card>
  );
}
