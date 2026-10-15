import React from "react";
import {
  StyleProp,
  Text as RNText,
  TextProps as RNTextProps,
  View,
  ViewStyle,
} from "react-native";
import { fontSize, radius, spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

type TextVariant = "caption" | "body" | "sub" | "title" | "display" | "hero";

interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: "ink" | "ink2" | "ink3" | "brand" | "danger" | "ok" | "snow";
  weight?: "normal" | "medium" | "semibold" | "bold";
}

const toneMap: Record<NonNullable<TextProps["tone"]>, keyof ReturnType<typeof useTheme>["colors"]> = {
  ink: "ink",
  ink2: "ink2",
  ink3: "ink3",
  brand: "brand",
  danger: "danger",
  ok: "ok",
  snow: "snow",
};

export function Text({
  variant = "body",
  tone = "ink",
  weight = "normal",
  style,
  ...rest
}: TextProps) {
  const { colors } = useTheme();
  const sizes: Record<TextVariant, number> = {
    caption: fontSize.caption,
    body: fontSize.body,
    sub: fontSize.sub,
    title: fontSize.title,
    display: fontSize.display,
    hero: fontSize.hero,
  };
  const weights = {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  } as const;
  return (
    <RNText
      {...rest}
      style={[
        {
          fontSize: sizes[variant],
          fontWeight: weights[weight],
          color: colors[toneMap[tone]],
          letterSpacing: variant === "caption" ? 0.2 : 0,
        },
        style,
      ]}
    />
  );
}

export function Card({
  children,
  style,
  accent,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  accent?: string;
}) {
  const { colors, scheme } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.line,
          padding: spacing.lg,
          overflow: "hidden",
          ...(scheme === "light"
            ? {
                shadowColor: "#0b1220",
                shadowOpacity: 0.06,
                shadowRadius: 16,
                shadowOffset: { width: 0, height: 8 },
                elevation: 2,
              }
            : {}),
        },
        style,
      ]}
    >
      {accent ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            backgroundColor: accent,
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

export function Chip({
  label,
  color,
  soft,
}: {
  label: string;
  color: string;
  soft: string;
}) {
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: soft,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
      }}
    >
      <Text variant="caption" weight="semibold" style={{ color }}>
        {label}
      </Text>
    </View>
  );
}

export function Divider() {
  const { colors } = useTheme();
  return (
    <View style={{ height: 1, backgroundColor: colors.line, width: "100%" }} />
  );
}

export function Spacer({ size = spacing.md }: { size?: number }) {
  return <View style={{ height: size }} />;
}
