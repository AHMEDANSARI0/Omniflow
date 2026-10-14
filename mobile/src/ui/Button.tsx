import React from "react";
import {
  Pressable,
  ActivityIndicator,
  StyleProp,
  View,
  ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated from "react-native-reanimated";
import { Text } from "@/ui/primitives";
import { usePressFeedback, tapHaptic } from "@/ui/anim";
import { radius, spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Variant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
}: ButtonProps) {
  const { colors, scheme } = useTheme();
  const { animatedStyle, onPressIn, onPressOut } = usePressFeedback();
  const inactive = disabled || loading;

  const handle = () => {
    if (inactive) return;
    tapHaptic();
    onPress();
  };

  const inner = (
    <>
      {loading ? (
        <ActivityIndicator
          color={variant === "primary" ? "#ffffff" : colors.brand}
          size="small"
        />
      ) : null}
      <Text
        weight="semibold"
        style={{
          color:
            variant === "primary"
              ? "#ffffff"
              : variant === "danger"
                ? colors.danger
                : colors.brand,
          marginLeft: loading ? spacing.xs : 0,
        }}
      >
        {title}
      </Text>
    </>
  );

  const content =
    variant === "primary" ? (
      <LinearGradient
        colors={[colors.brand, colors.ai]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          borderRadius: radius.md,
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.sm + 2,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          opacity: inactive ? 0.55 : 1,
        }}
      >
        {inner}
      </LinearGradient>
    ) : (
      <View
        style={{
          borderRadius: radius.md,
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.sm + 2,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          backgroundColor:
            variant === "danger"
              ? colors.dangerSoft
              : variant === "secondary"
                ? colors.brandSoft
                : "transparent",
          opacity: inactive ? 0.55 : 1,
        }}
      >
        {inner}
      </View>
    );

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive }}
      disabled={inactive}
      onPress={handle}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[animatedStyle, { alignSelf: "stretch" }, style]}
    >
      {content}
    </AnimatedPressable>
  );
}
