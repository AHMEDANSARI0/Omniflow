import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuthStore } from "@/store/auth";

/**
 * Admin surface. P0 gates on the same CP session (owner accounts); §275 adds
 * the proper per-user guard: a Neon-backed mobile-admin session verified
 * server-side by the CP (mobile_admins / /api/v1/mobile/admin/*).
 */
export default function AdminLayout() {
  const status = useAuthStore((s) => s.status);
  if (status !== "authenticated") return <Redirect href="/login" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
