import { Redirect } from "expo-router";
import { useAuthStore } from "@/store/auth";
import { isAdminApp } from "@/config/env";

/**
 * Entry gate: signed out -> login; signed in -> the variant's home.
 * Role routing for the Admin variant lands with its Supabase guard (P1);
 * today the Admin build reuses the same CP session for platform owners.
 */
export default function Index() {
  const status = useAuthStore((s) => s.status);
  if (status !== "authenticated") return <Redirect href="/login" />;
  return <Redirect href={isAdminApp ? "/(admin)/(tabs)" : "/(client)/(tabs)"} />;
}
