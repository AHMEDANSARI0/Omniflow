import React from "react";
import { Screen } from "@/ui/Screen";
import { Text, Spacer } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";

export default function ActivityScreen() {
  return (
    <Screen scroll={false}>
      <Text variant="display" weight="bold">
        Activity
      </Text>
      <Spacer size={spacing.sm} />
      <Text tone="ink3">
        Workflow runs, approvals and automation events appear here in the next
        build (P3), streamed from the existing CP activity APIs.
      </Text>
    </Screen>
  );
}
