import React, { useState } from "react";
import { Pressable, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/store/auth";
import { useSettingsStore } from "@/store/settings";
import { appVersion } from "@/config/env";
import { haptics } from "@/lib/haptics";
import { checkForUpdatesNow } from "@/lib/updates";
import { Screen } from "@/ui/Screen";
import { Card, Divider, Spacer, Text } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §280 P5 admin more: analytics shortcut + the same local notification /
 * sound / haptic switches as the client app (shared settings store), plus
 * version, OTA update check and sign out from P1.
 */
export default function AdminMore() {
  const { colors } = useTheme();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const prefs = useSettingsStore((s) => s.prefs);
  const updateSettings = useSettingsStore((s) => s.update);
  const [checking, setChecking] = useState(false);

  const onCheckUpdates = async () => {
    setChecking(true);
    await checkForUpdatesNow();
    setChecking(false);
  };

  const toggleRow = (
    label: string,
    hint: string,
    value: boolean,
    onChange: (v: boolean) => void,
  ) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        paddingVertical: spacing.sm,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text weight="semibold">{label}</Text>
        <Text variant="caption" tone="ink3">
          {hint}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={(v) => {
          void haptics.selection();
          onChange(v);
        }}
        trackColor={{ false: colors.line2, true: colors.ok }}
        thumbColor={"#ffffff"}
      />
    </View>
  );

  return (
    <Screen>
      <Text variant="display" weight="bold">
        More
      </Text>
      <Spacer size={spacing.lg} />

      <Card>
        <Text weight="semibold">{user?.name ?? user?.email ?? "Owner"}</Text>
        {user?.email ? (
          <Text variant="caption" tone="ink3">
            {user.email}
          </Text>
        ) : null}
        <Spacer size={spacing.xs} />
        <Text variant="caption" tone="brand" weight="semibold">
          ADMIN ACCESS
        </Text>
      </Card>

      <Spacer size={spacing.md} />

      {/* §280: analytics shortcut */}
      <Pressable onPress={() => router.push("/analytics")}>
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                backgroundColor: colors.brandSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="stats-chart-outline" size={18} color={colors.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Text weight="semibold">Analytics</Text>
              <Text variant="caption" tone="ink3">
                Website traffic + AI engine quality
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.ink3} />
          </View>
        </Card>
      </Pressable>

      <Spacer size={spacing.md} />

      {/* §279/§280: shared notification preferences */}
      <Card>
        <Text weight="semibold">Notifications</Text>
        <Spacer size={spacing.sm} />
        {toggleRow(
          "Alerts",
          "Local alerts while the app is closed",
          prefs.notifications,
          (v) => void updateSettings({ notifications: v }),
        )}
        <Divider />
        {toggleRow(
          "Sounds",
          "Play a sound with alerts",
          prefs.sounds,
          (v) => void updateSettings({ sounds: v }),
        )}
        <Divider />
        {toggleRow(
          "Haptics",
          "Vibration feedback on actions",
          prefs.haptics,
          (v) => void updateSettings({ haptics: v }),
        )}
      </Card>

      <Spacer size={spacing.md} />

      <Card>
        <Row label="App version" value={`v${appVersion}`} />
        <Spacer size={spacing.sm} />
        <Divider />
        <Spacer size={spacing.sm} />
        <Row label="Update channel" value="Auto (on launch)" />
        <Spacer size={spacing.lg} />
        <Button
          variant="secondary"
          title={checking ? "Checking…" : "Check for updates"}
          onPress={onCheckUpdates}
        />
      </Card>

      <Spacer size={spacing.md} />
      <Button variant="danger" title="Sign out" onPress={() => void logout()} />
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text variant="body" tone="ink3">
        {label}
      </Text>
      <Text variant="body" weight="semibold">
        {value}
      </Text>
    </View>
  );
}
