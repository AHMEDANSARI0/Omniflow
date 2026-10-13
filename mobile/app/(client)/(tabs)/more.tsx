import React, { useState } from "react";
import { View } from "react-native";
import { useAuthStore } from "@/store/auth";
import { appVersion } from "@/config/env";
import { checkForUpdatesNow } from "@/lib/updates";
import { Screen } from "@/ui/Screen";
import { Card, Divider, Spacer, Text } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { spacing } from "@/ui/tokens";

export default function MoreScreen() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [checking, setChecking] = useState(false);

  const onCheckUpdates = async () => {
    setChecking(true);
    const updated = await checkForUpdatesNow();
    setChecking(false);
    if (!updated) {
      // No OTA channel configured or already current - silent is fine (P0).
    }
  };

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
