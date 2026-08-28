"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";


export default function SignOutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    if (loading) return;
    setLoading(true);

    try {
      await fetch("/api/omniflow/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
    } finally {
      router.replace("/dashboard/login");
      router.refresh();
      setLoading(false);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleSignOut}
        disabled={loading}
        title="Sign out"
        aria-label="Sign out"
        className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.02] text-sm text-slate-400 transition-colors duration-300 hover:border-white/[0.2] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        ⏻
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      className="w-full rounded-xl border border-white/[0.1] bg-white/[0.02] px-5 py-2.5 text-sm font-medium text-slate-300 transition-colors duration-300 hover:border-white/[0.2] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
