import React from "react";
import { Redirect } from "expo-router";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { loginInputSchema, type LoginInput } from "@/api/auth";
import { useAuthStore } from "@/store/auth";
import { isAdminApp } from "@/config/env";
import { Screen } from "@/ui/Screen";
import { Text, Spacer, Card } from "@/ui/primitives";
import { TextField } from "@/ui/TextField";
import { Button } from "@/ui/Button";
import { errorHaptic, successHaptic } from "@/ui/anim";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";
import { useState } from "react";

export default function LoginScreen() {
  const { colors } = useTheme();
  const { status, login } = useAuthStore();
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginInputSchema),
    defaultValues: { email: "", password: "" },
  });

  if (status === "authenticated") {
    return <Redirect href={isAdminApp ? "/(admin)/(tabs)" : "/(client)/(tabs)"} />;
  }

  const onSubmit = async (input: LoginInput) => {
    setServerError(null);
    setBusy(true);
    try {
      await login(input);
      successHaptic();
    } catch (err) {
      errorHaptic();
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      setServerError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen keyboard scroll={false}>
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Animated.View entering={FadeInDown.duration(450)}>
          <Text variant="hero" weight="bold" tone="ink">
            OmniFlow
          </Text>
          <Text variant="sub" tone="ink3">
            {isAdminApp
              ? "Platform control, in your pocket."
              : "Your business, always within reach."}
          </Text>
        </Animated.View>

        <Spacer size={spacing.xxl} />

        <Card>
          <Controller
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <TextField
                label="Email"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                placeholder="you@company.com"
              />
            )}
          />
          <Controller
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <TextField
                label="Password"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                secureTextEntry
                autoComplete="password"
                placeholder="••••••••"
              />
            )}
          />
          {serverError ? (
            <Text variant="caption" tone="danger" style={{ marginBottom: spacing.sm }}>
              {serverError}
            </Text>
          ) : null}
          <Button
            title={busy ? "Signing in…" : "Sign in"}
            loading={busy}
            onPress={form.handleSubmit(onSubmit)}
          />
        </Card>

        <Spacer size={spacing.lg} />
        <Text variant="caption" tone="ink3" style={{ textAlign: "center" }}>
          Protected by the OmniFlow Control Plane. Trouble signing in? Contact your
          account manager.
        </Text>
      </View>
    </Screen>
  );
}
