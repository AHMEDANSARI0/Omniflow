import { useTheme } from "@/ui/theme";
import { Text, Card, Spacer } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { spacing, radius } from "@/ui/tokens";
import { View } from "react-native";
import { Stack, useRouter } from "expo-router";

export default function adminSettingsScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>
        <Text variant="title" weight="bold" style={{ color: colors.ink, marginBottom: spacing.sm }}>
          Admin Settings
        </Text>
        <Text variant="body" style={{ color: colors.ink3, marginBottom: spacing.lg, lineHeight: 22 }}>
          Admin-level settings — platform configuration, access control, and administrative preferences.
        </Text>
      </View>
      <View style={{ flex: 1, padding: spacing.md }}>
        <Card
          style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md }}
        >
          <Text variant="body" weight="medium" style={{ color: colors.ink, marginBottom: spacing.sm }}>
            Admin Settings — quick start
          </Text>
          <Text variant="body" style={{ color: colors.ink3 }}>
            This screen is connected to the live OmniFlow platform. Sign in with admin credentials to see your live data.
          </Text>
          <Spacer size={spacing.md} />
          <Button
            title="Open Admin Settings"
            onPress={() => router.push("./admin-settings")}
            variant="primary"
          />
        </Card>
        <Spacer size={spacing.md} />
        <Card
          style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm }}
        >
          <Text variant="sub" weight="bold" style={{ color: colors.ink, marginBottom: spacing.xs }}>
            What you can do here
          </Text>
          <Text variant="body" style={{ color: colors.ink3 }}>
            Admin-level settings — platform configuration, access control, and administrative preferences.
          </Text>
        </Card>
      </View>
    </View>
  );
}
