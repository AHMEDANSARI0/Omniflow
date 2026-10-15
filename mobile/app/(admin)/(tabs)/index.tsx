import React from "react";
import { Screen } from "@/ui/Screen";
import { Card, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";

export default function AdminOverview() {
  return (
    <Screen scroll={false}>
      <Text variant="display" weight="bold">
        Admin
      </Text>
      <Spacer size={spacing.lg} />
      <Card accent="#7c3aed">
        <Text weight="semibold">Management console - next build</Text>
        <Spacer size={spacing.xs} />
        <Text variant="caption" tone="ink3">
          Platform overview, client accounts, monitoring and security alerts
          arrive in P5 together with the per-user admin authorization guard on
          the Control Plane.
        </Text>
      </Card>
    </Screen>
  );
}
