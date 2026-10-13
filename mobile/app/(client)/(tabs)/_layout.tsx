import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Platform } from "react-native";
import { useTheme } from "@/ui/theme";

/**
 * Futurist tab bar: translucent blur surface, hairline top border,
 * brand-tinted active tint. Icons only on Android keep labels for
 * accessibility; both stay large-touch-target.
 */
export default function ClientTabs() {
  const { colors, scheme } = useTheme();

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
