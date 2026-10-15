import React from "react";
import {
  ScrollView,
  StyleProp,
  View,
  ViewStyle,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * Base screen: canvas background, safe area, and a subtle aurora wash at
 * the top (brand -> ai, very low opacity) that gives the futurist feel
 * without any blur/parallax cost.
 */
export function Screen({
  children,
  scroll = true,
  keyboard = false,
  contentStyle,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  keyboard?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { colors, scheme } = useTheme();
  const aurora: [string, string, string] =
    scheme === "light"
      ? ["rgba(79,70,229,0.10)", "rgba(124,58,237,0.06)", "rgba(6,182,212,0.04)"]
      : ["rgba(109,104,240,0.16)", "rgba(163,121,247,0.08)", "rgba(56,207,230,0.04)"];

  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[{ padding: spacing.lg, flexGrow: 1 }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1, padding: spacing.lg }, contentStyle]}>{children}</View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top"]}>
      <View style={{ flex: 1 }}>
        <LinearGradient
          colors={aurora}
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 260 }}
          pointerEvents="none"
        />
        {keyboard ? (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            {body}
          </KeyboardAvoidingView>
        ) : (
          body
        )}
      </View>
    </SafeAreaView>
  );
}

/** Pulsing status dot - WhatsApp connectivity, live pipelines. */
export function StatusDot({ color }: { color: string }) {
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        shadowColor: color,
        shadowOpacity: 0.8,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 0 },
      }}
    />
  );
}
