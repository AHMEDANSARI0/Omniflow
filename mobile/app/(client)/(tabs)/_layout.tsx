import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Platform } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { listConversations } from "@/api/portal";
import { useTheme } from "@/ui/theme";

/**
 * Futurist tab bar: translucent blur surface, hairline top border,
 * brand-tinted active tint. Icons only on Android keep labels for
 * accessibility; both stay large-touch-target.
 */
export default function ClientTabs() {
  const { colors, scheme } = useTheme();

  // §279 P4: unread badge on the Inbox tab (shares the dashboard's counts
  // query cache - one cheap request every 30s feeds both).
  const counts = useQuery({
    queryKey: ["conversations", "counts"],
    queryFn: () => listConversations({ limit: 1 }),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const unread = counts.data?.counts?.unread ?? 0;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.ink3,
        tabBarStyle: {
          backgroundColor: scheme === "dark" ? "rgba(13,20,34,0.88)" : "rgba(255,255,255,0.82)",
          borderTopColor: colors.line,
          borderTopWidth: 0.5,
          height: Platform.OS === "ios" ? 88 : 64,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", letterSpacing: 0.2 },
        tabBarBackground: () => <BlurView intensity={40} style={{ flex: 1 }} tint={scheme === "dark" ? "dark" : "light"} />,
        tabBarIconStyle: { marginTop: 2 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "grid" : "grid-outline"} size={size} color={typeof color === "string" ? color : colors.brand} />
          ),
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: "Inbox",
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, fontSize: 10 },
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "chatbubbles" : "chatbubbles-outline"} size={size} color={typeof color === "string" ? color : colors.brand} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "pulse" : "pulse-outline"} size={size} color={typeof color === "string" ? color : colors.brand} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "apps" : "apps-outline"} size={size} color={typeof color === "string" ? color : colors.brand} />
          ),
        }}
      />
    </Tabs>
  );
}
