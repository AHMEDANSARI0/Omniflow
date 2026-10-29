import { useTheme } from "@/ui/theme";
import { Text, Card, Spacer } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { spacing, radius } from "@/ui/tokens";
import { View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useState, useEffect } from "react";
import { api } from "@/api/client";
import { ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";

// §290 Phase 8 - Integrations screen
export default function integrationsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        setIsMock(false);
        const result = await api.get<any>("/api/v1/portal/integrations");
        setItems(result?.integrations ?? result?.integrations ?? []);
      } catch (err: any) {
        setIsMock(true);
        setItems([{ "id": "1", "name": "WhatsApp", "status": "connected", "lastSync": "2024-01-15" }]);
        setError(err?.message ?? "Using offline data");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>
        <Text variant="title" weight="bold" style={{ color: colors.ink }}>
          Integrations
        </Text>
        <Text variant="body" style={{ color: colors.ink3, marginTop: spacing.xs }}>
          Connect with other tools.
        </Text>
        {isMock && (
          <Text variant="caption" tone="ok" style={{ alignSelf: "flex-start" }}>
            Offline mode
          </Text>
        )}
      </View>
      <View style={{ flex: 1, padding: spacing.md }}>
        {loading && (
          <View style={{ alignItems: "center", justifyContent: "center", height: 200 }}>
            <ActivityIndicator size="large" color={colors.brand} />
          </View>
        )}
        {!loading && items.length === 0 && (
          <Card style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, alignItems: "center" }}>
            <Text variant="body" style={{ color: colors.ink3 }}>No items found</Text>
          </Card>
        )}
        {!loading && items.length > 0 && (
          <Card style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm }}>
            {items.map((item) => (
              <View
                key={item.id ?? Math.random()}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  paddingVertical: spacing.sm,
                  borderBottomWidth: 0.5,
                  borderBottomColor: colors.line,
                }}
              >
                <Ionicons
                  name="ellipse"
                  size={16}
                  color={colors.brand}
                  style={{ marginRight: spacing.sm, marginTop: 2 }}
                />
                <View style={{ flex: 1 }}>
                  <Text variant="body" weight="medium" style={{ color: colors.ink }}>
                    {item.title ?? item.name ?? item.label ?? 'Item'}
                  </Text>
              <Text variant="body" style={{ color: colors.inkmarginTop: spacing.xs }}>Status: {item.status}</Text>
              <Text variant="body" style={{ color: colors.ink, marginTop: spacing.xs }}>Last Sync: {item.lastSync}</Text>
                </View>
              </View>
            ))}
          </Card>
        )}
      </View>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderTopWidth: 0.5, borderTopColor: colors.line }}>
        <Button
          title="Refresh"
          onPress={() => window.location.reload()}
          variant="primary"
        />
      </View>
    </View>
  );
}
