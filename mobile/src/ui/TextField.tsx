import React, { useState } from "react";
import { TextInput, TextInputProps, View } from "react-native";
import { Text } from "@/ui/primitives";
import { radius, spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string;
}

/** Futurist field: animated focus ring in brand gradient tone. */
export function TextField({ label, error, style, ...rest }: TextFieldProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text variant="caption" weight="semibold" tone="ink2">
        {label.toUpperCase()}
      </Text>
      <TextInput
        {...rest}
        placeholderTextColor={colors.ink3}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        style={[
          {
            marginTop: 6,
            backgroundColor: colors.soft,
            borderRadius: radius.md,
            borderWidth: focused ? 1.5 : 1,
            borderColor: error
              ? colors.danger
              : focused
                ? colors.brand
                : colors.line,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            fontSize: 16,
            color: colors.ink,
          },
          style,
        ]}
      />
      {error ? (
        <Text variant="caption" tone="danger" style={{ marginTop: 4 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
