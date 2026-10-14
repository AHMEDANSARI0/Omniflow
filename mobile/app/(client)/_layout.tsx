import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuthStore } from "@/store/auth";

/** Client surface: reachable only with a valid CP session. */
export default function ClientLayout() {
  const status = useAuthStore((s) => s.status);
  if (status !== "authenticated") return <Redirect href="/login" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
