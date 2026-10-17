import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/store/auth";
import { appVersion } from "@/config/env";
import { checkForUpdatesNow } from "@/lib/updates";
import { Screen } from "@/ui/Screen";
import { Card, Divider, Spacer, Text } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §278 P3 settings hub: business profile, contacts, workflows and
 * analytics now open real screens (CP-backed); version, OTA update check
 * and sign out stay from P1.
 */
export default function MoreScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [checking, setChecking] = useState(false);

  const onCheckUpdates = async () => {
    setChecking(true);
    await checkForUpdatesNow();
    setChecking(false);
  };

  const link = (
    icon: keyof typeof Ionicons.glyphMap,
    label: string,
    hint: string,
    href: string,
  ) => (
    <Pressable onPress={() => router.push(href as never)}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.md,
          paddingVertical: spacing.md,
        }}
      >
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
          <Ionicons name={icon} size={18} color={colors.brand} />
        </View>
        <View style={{ flex: 1 }}>
          <Text weight="semibold">{label}</Text>
          <Text variant="caption" tone="ink3">
            {hint}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.ink3} />
      </View>
      <Divider />
    </Pressable>
  );

  return (
    <Screen>
      <Text variant="display" weight="bold">
        More
      </Text>
      <Spacer size={spacing.lg} />

      <Card>
        <Text weight="semibold">{user?.name ?? user?.email ?? "Signed in"}</Text>
        {user?.email ? (
          <Text variant="caption" tone="ink3">
            {user.email}
          </Text>
        ) : null}
      </Card>

      <Spacer size={spacing.md} />

      <Card>
        {link(
          "briefcase-outline",
          "Business profile",
          "Name, tagline, phone and address used across channels",
          "/profile",
        )}
        {link(
          "people-outline",
          "Contacts",
          "Every customer across WhatsApp, email and social",
          "/contacts",
        )}
        {link(
          "git-branch-outline",
          "Workflows",
          "View automations and pause / activate them",
          "/workflows",
        )}
        {link(
          "stats-chart-outline",
          "Analytics",
          "Customers, tiers, repeat share and languages",
          "/analytics",
        )}
      </Card>

      <Spacer size={spacing.md} />

      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text variant="body" tone="ink3">
            App version
          </Text>
          <Text variant="body" weight="semibold">
            v{appVersion}
          </Text>
        </View>
        <Spacer size={spacing.sm} />
        <Divider />
        <Spacer size={spacing.sm} />
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text variant="body" tone="ink3">
            Update channel
          </Text>
          <Text variant="body" weight="semibold">
            Auto (on launch)
          </Text>
        </View>
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
