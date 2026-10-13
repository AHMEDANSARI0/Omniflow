import React from "react";
import { Link } from "expo-router";
import { Screen } from "@/ui/Screen";
import { Text, Spacer } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";

export default function NotFound() {
  return (
    <Screen scroll={false}>
      <Text variant="display" weight="bold">
        Page not found
      </Text>
      <Spacer size={spacing.sm} />
      <Text tone="ink3">The screen you were looking for does not exist.</Text>
      <Spacer size={spacing.lg} />
      <Link href="/" style={{ fontWeight: "600" }}>
        Go home
      </Link>
    </Screen>
  );
}
