"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";


interface LoginErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export default function DashboardLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceRequired, setWorkspaceRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setError(null);
    setLoading(true);

    const body: Record<string, unknown> = { email, password };
    if (workspaceId.trim()) body.client_id = workspaceId.trim();

    try {
      const response = await fetch("/api/omniflow/auth/login", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let payload: LoginErrorPayload = {};
        try {
          payload = (await response.json()) as LoginErrorPayload;
        } catch {
          // Use the safe fallback below.
        }

        const code = payload.error?.code;
        const message = payload.error?.message;
        if (code === "client_selection_required") setWorkspaceRequired(true);
        setError(
          typeof message === "string"
            ? message
            : "Sign in failed. Please try again."
        );
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Login is temporarily unavailable. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#07111f] px-5 py-10">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[640px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.07)_0%,transparent_70%)]" />
      <div className="pointer-events-none absolute -bottom-40 left-1/4 h-72 w-96 rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.06)_0%,transparent_70%)]" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06]">
            <span className="of-pulse h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]" />
          </div>
          <h1 className="text-xl font-semibold tracking-[-0.03em] text-white">
            Omni<span className="text-cyan-400">Flow</span>
          </h1>
          <p className="mt-1.5 text-xs uppercase tracking-widest text-slate-500">
            Secure client portal
          </p>
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6 sm:p-7">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-slate-400">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                maxLength={320}
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                placeholder="you@business.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-400">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                maxLength={1024}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                placeholder="••••••••"
              />
            </div>

            <div>
              <label htmlFor="workspace_id" className="mb-1.5 block text-xs font-medium text-slate-400">
                Workspace ID {workspaceRequired ? "*" : "(if provided)"}
              </label>
              <input
                id="workspace_id"
                name="workspace_id"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                required={workspaceRequired}
                autoComplete="off"
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value.replace(/\D/g, ""))}
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                placeholder="Only needed for multiple workspaces"
              />
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                role="alert"
                aria-live="polite"
                className="rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300"
              >
                {error}
              </motion.p>
            )}

            <motion.button
              type="submit"
              disabled={loading}
              whileHover={{ y: loading ? 0 : -1 }}
              whileTap={{ scale: loading ? 1 : 0.98 }}
              className="w-full rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity duration-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Signing in…" : "Sign in securely"}
            </motion.button>
          </form>
        </div>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-slate-600">
          Access and refresh credentials stay in secure HttpOnly cookies and are
          never exposed to browser storage.
        </p>
        <p className="mt-3 text-center text-xs text-slate-600">
          Need an account?{" "}
          <Link href="/#get-started" className="text-cyan-400/80 transition-colors hover:text-cyan-300">
            Request early access
          </Link>
        </p>
      </motion.div>
    </main>
  );
}
