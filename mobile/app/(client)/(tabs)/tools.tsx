import { useTheme } from "@/ui/theme";
import { Text, Card, Spacer } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius } from "@/ui/tokens";
import { View, StyleSheet } from "react-native";
import { Stack, useRouter } from "expo-router";

const TOOLS = [
  { name: "ai-chat", label: "AI Chat", desc: "Chat with your AI assistant" },
  { name: "knowledge-base", label: "Knowledge Base", desc: "Search your knowledge base" },
  { name: "saved-replies", label: "Saved Replies", desc: "Quick-reply templates" },
  { name: "broadcasts", label: "Broadcasts", desc: "Send messages to many contacts" },
  { name: "automations", label: "Automations", desc: "Auto-replies and workflows" },
  { name: "pipeline", label: "Pipeline", desc: "Manage your deal pipeline" },
  { name: "settings", label: "Settings", desc: "App settings and preferences" },
  { name: "growth", label: "Growth", desc: "Growth and retention tools" },
  { name: "integrations", label: "Integrations", desc: "Connect your tools" },
];

export default function ToolsTab() {
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Ionicons name="settings" size={22} color={colors.brand} />
          <Text variant="title" weight="bold" style={{ color: colors.ink }}>
            Tools & Features
          </Text>
        </View>
        <Text variant="body" style={{ color: colors.ink3, marginBottom: spacing.lg, marginTop: spacing.sm }}>
          All your OmniFlow tools in one place.
        </Text>
      </View>
      <View style={{ flex: 1, padding: spacing.md }}>
        {TOOLS.map((tool) => (
          <Card
            key={tool.name}
            style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <Text variant="sub" weight="bold" style={{ color: colors.ink, marginBottom: spacing.xs }}>
                  {tool.label}
                </Text>
                <Text variant="body" style={{ color: colors.ink3 }}>
                  {tool.desc}
                </Text>
              </View>
              <Button
                title="Open"
                onPress={() => router.push("../" + tool.name)}
                variant="primary"
                style={{ flexShrink: 0 }}
              />
            </View>
          </Card>
        ))}
      </View>
    </View>
  );
}
