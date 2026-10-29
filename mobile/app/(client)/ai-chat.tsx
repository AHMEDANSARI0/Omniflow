import { useTheme } from "@/ui/theme";
import { Text, Card, Spacer } from "@/ui/primitives";
import { Button } from "@/ui/Button";
import { spacing, radius } from "@/ui/tokens";
import { View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useState, useEffect } from "react";
import { api } from "@/api/client";
import { ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";

// OMNI Client - AI Chat screen
export default function aiChatScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        setIsMock(false);
        const result = await api.get<any>("/api/v1/portal/ai/chat");
        setMessages(result?.messages ?? []);
      } catch (err) {
        setIsMock(true);
        setMessages([{"id":"1","role":"user","content":"What are your business hours?","timestamp":"2024-01-15T10:00:00Z"},{"id":"2","role":"assistant","content":"Our business hours are Monday to Friday, 9 AM to 6 PM. How can I help you?","timestamp":"2024-01-15T10:00:30Z"},{"id":"3","role":"user","content":"Do you offer weekend support?","timestamp":"2024-01-15T10:01:00Z"},{"id":"4","role":"assistant","content":"Yes, we offer limited weekend support from 10 AM to 2 PM on Saturdays.","timestamp":"2024-01-15T10:01:30Z"}]);
        setError(err?.message ?? "Using offline data");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const formatTime = (ts) => {
    try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch { return ""; }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>
        <Text variant="title" weight="bold" style={{ color: colors.ink }}>AI Chat</Text>
        <Text variant="body" style={{ color: colors.ink3, marginTop: spacing.xs }}>Chat with AI assistant</Text>
        {isMock && <Text variant="caption" tone="ok" style={{ alignSelf: "flex-start" }}>Offline mode</Text>}
      </View>
      <View style={{ flex: 1, padding: spacing.md }}>
        {loading && <View style={{ alignItems: "center", justifyContent: "center", height: 200 }}><ActivityIndicator size="large" color={colors.brand} /></View>}
        {!loading && messages.length === 0 && <Card style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, alignItems: "center" }}><Text variant="body" style={{ color: colors.ink3 }}>No messages</Text></Card>}
        {!loading && messages.length > 0 && (
          <Card style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm }}>
            {messages.map((msg) => (
              <View key={msg.id} style={{ flexDirection: "row", alignItems: "flex-start", paddingVertical: spacing.sm }}>
                <Ionicons name={msg.role === "assistant" ? "flash" : "person"} size={20} color={msg.role === "assistant" ? colors.brand : colors.ink3} style={{ marginRight: spacing.sm, marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text variant="body" style={{ color: colors.ink }}>{msg.content}</Text>
                  <Text variant="caption" tone="ink3" style={{ marginTop: 2 }}>{formatTime(msg.timestamp)}</Text>
                </View>
              </View>
            ))}
          </Card>
        )}
      </View>
      <View style={{ padding: spacing.md, backgroundColor: colors.surface, borderTopWidth: 0.5, borderTopColor: colors.line }}>
        <Button title="New Chat" onPress={() => router.push("./ai-chat")} variant="primary" />
      </View>
    </View>
  );
}
