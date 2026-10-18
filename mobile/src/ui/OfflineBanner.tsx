/**
 * §281 P6: a slim, non-blocking offline banner driven by the net store. It
 * sits above the navigator (never overlays content) and disappears the moment
 * the API layer sees any successful HTTP response.
 */

import React from "react";
import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNetStore } from "@/store/net";
import { Text } from "@/ui/primitives";
import { radius, spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

export function OfflineBanner(): React.JSX.Element | null {
  const online = useNetStore((s) => s.online);
  const { colors } = useTheme();
  if (online) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        backgroundColor: colors.warnSoft,
        paddingVertical: 6,
        paddingHorizontal: spacing.md,
        borderBottomLeftRadius: radius.md,
        borderBottomRightRadius: radius.md,
      }}
      accessibilityRole="alert"
      accessibilityLabel="You are offline. Showing cached data."
    >
      <Ionicons name="cloud-offline-outline" size={14} color={colors.warn} />
      <Text variant="caption" weight="bold" style={{ color: colors.warn }}>
        You're offline - showing last saved data
      </Text>
    </View>
  );
}
