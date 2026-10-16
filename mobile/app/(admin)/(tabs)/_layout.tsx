import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";
import { BlurView } from "expo-blur";
import { useTheme } from "@/ui/theme";

export default function AdminTabs() {
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
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Overview",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "shield-checkmark" : "shield-checkmark-outline"} size={size} color={typeof color === "string" ? color : colors.brand} />
          ),
        }}
      />
      <Tabs.Screen
        name="users"
        options={{
          title: "Clients",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "people" : "people-outline"} size={size} color={typeof color === "string" ? color : colors.brand} />
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
