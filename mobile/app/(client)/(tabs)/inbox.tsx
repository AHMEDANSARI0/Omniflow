import React from "react";
import { Screen } from "@/ui/Screen";
import { Text, Spacer } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";

export default function InboxScreen() {
  return (
    <Screen scroll={false}>
      <Text variant="display" weight="bold">
        Inbox
      </Text>
      <Spacer size={spacing.sm} />
      <Text tone="ink3">
        The unified conversation inbox connects in the next build (P2): search,
        filters, full history, replies, media and voice messages.
      </Text>
    </Screen>
  );
}
