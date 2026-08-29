"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { motion } from "motion/react";


export default function ResetPasswordPage() {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setError(null);

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/omniflow/auth/reset-password", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ code, new_password: password }),
      });

      if (!response.ok) {
        let payload: { error?: { code?: unknown; message?: unknown } } = {};
        try {
          payload = (await response.json()) as typeof payload;
        } catch {
          // Use the safe fallback below.
        }
        const message = payload.error?.message;
        setError(
          typeof message === "string"
            ? message
            : "Reset failed. Please request a new code and try again."
        );
        return;
      }

      setDone(true);
    } catch {
      setError("Service is temporarily unavailable. Please try again.");
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
            Set a new password
          </p>
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6 sm:p-7">
          {done ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-slate-300">
                Password update ho gaya. Ab naye password se sign in karein.
              </p>
              <Link
                href="/dashboard/login"
                className="inline-block rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90"
              >
                Go to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="code" className="mb-1.5 block text-xs font-medium text-slate-400">
                  Reset code (6 digits)
                </label>
                <input
                  id="code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-center text-lg tracking-[0.4em] text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                  placeholder="••••••"
                />
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-400">
                  New password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  maxLength={1024}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                  placeholder="At least 8 characters"
                />
              </div>

              <div>
                <label htmlFor="confirm" className="mb-1.5 block text-xs font-medium text-slate-400">
                  Confirm new password
                </label>
                <input
                  id="confirm"
                  name="confirm"
                  type="password"
                  required
                  minLength={8}
                  maxLength={1024}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                  placeholder="Repeat password"
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
                {loading ? "Updating…" : "Set new password"}
              </motion.button>
            </form>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-slate-600">
          <Link href="/dashboard/login" className="text-cyan-400/80 transition-colors hover:text-cyan-300">
            Back to sign in
          </Link>
        </p>
      </motion.div>
    </main>
  );
}
