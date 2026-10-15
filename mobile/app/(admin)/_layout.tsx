import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuthStore } from "@/store/auth";

/**
 * Admin surface. P0 gates on the same CP session (owner accounts); P1 adds
 * the proper per-user guard: Supabase JWT verified server-side by the CP +
 * profiles.role = "admin" (/api/v1/mobile/admin/*).
 */
export default function AdminLayout() {
  const status = useAuthStore((s) => s.status);
  if (status !== "authenticated") return <Redirect href="/login" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
