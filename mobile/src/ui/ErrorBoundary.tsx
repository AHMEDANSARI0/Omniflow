/**
 * §281 P6 hardening: a render-crash net around the whole navigator. Any
 * unexpected component exception lands on a calm recovery card instead of a
 * red screen - "Try again" resets the boundary, and the app keeps its data
 * (query cache and stores live above this boundary).
 */

import React from "react";
import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { logger } from "@/lib/logger";
import { Button } from "@/ui/Button";
import { Card, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

interface ErrorBoundaryState {
  error: Error | null;
}

function Fallback({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        padding: spacing.lg,
        justifyContent: "center",
        backgroundColor: colors.canvas,
      }}
    >
      <Card accent={colors.warn}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Ionicons name="warning-outline" size={20} color={colors.warn} />
          <Text weight="bold">Something went wrong</Text>
        </View>
        <Spacer size={spacing.sm} />
        <Text variant="caption" tone="ink3">
          An unexpected error hit this screen. Your data is safe - retry, and
          if it keeps happening, restart the app.
        </Text>
        <Spacer size={spacing.md} />
        <Button title="Try again" onPress={onRetry} />
      </Card>
    </View>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    logger.warn("render crash caught by ErrorBoundary", error);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <Fallback onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
