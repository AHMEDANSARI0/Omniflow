/** §282j: in-app update notification. Checks for OTA updates on launch and
 * shows a non-blocking banner with an "Update Now" button whenever a newer
 * JS bundle is available. The banner reappears on each launch until the user
 * applies the update (the app reloads with the new bundle).
 */

import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/ui/theme";
import { Text } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { Spacer } from "@/ui/primitives";
import { radius, spacing } from "@/ui/tokens";
import { getUpdateAvailability, checkForUpdatesNow } from "@/lib/updates";
import { logger } from "@/lib/logger";

export function UpdateBanner(): React.JSX.Element | null {
  const [available, setAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const { colors } = useTheme();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const isAvailable = await getUpdateAvailability();
      if (!cancelled && isAvailable) {
        setAvailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!available) return null;

  const handleUpdateNow = async () => {
    setUpdating(true);
    try {
      await checkForUpdatesNow();
    } catch (err) {
      logger.warn("update now failed", err);
    }
  };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: spacing.sm,
        backgroundColor: colors.brand,
        paddingVertical: 8,
        paddingHorizontal: spacing.md,
        borderBottomLeftRadius: radius.md,
        borderBottomRightRadius: radius.md,
      }}
      accessibilityRole="alert"
      accessibilityLabel="New update available"
    >
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
        <Ionicons name="rocket-outline" size={16} color={colors.snow} />
        <Spacer size={spacing.xs} />
        <Text variant="caption" weight="bold" style={{ color: colors.snow }}>
          New update available
        </Text>
      </View>
      <View style={{ flexShrink: 0, alignItems: "flex-end" }}>
        <Button
          title={updating ? "Updating..." : "Update Now"}
          onPress={handleUpdateNow}
          variant="primary"
          loading={updating}
          disabled={updating}
        />
        <Spacer size={spacing.xs} />
        <Button
          title="Later"
          onPress={() => setAvailable(false)}
          variant="ghost"
        />
      </View>
    </View>
  );
}