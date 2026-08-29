"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { motion } from "motion/react";


export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/omniflow/auth/forgot-password", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        let payload: { error?: { code?: unknown; message?: unknown } } = {};
        try {
          payload = (await response.json()) as typeof payload;
        } catch {
          // Use the safe fallback below.
        }
        const code = payload.error?.code;
        const message = payload.error?.message;
        if (code === "reset_not_configured") {
          setError(
            "Password reset is not set up on the server yet. Please contact support."
          );
          return;
        }
        setError(
          typeof message === "string" ? message : "Request failed. Please try again."
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
            Reset password
          </p>
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6 sm:p-7">
          {done ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-slate-300">
                If this email is registered, a 6-digit reset code has been
                generated.
              </p>
              <p className="text-xs leading-relaxed text-slate-500">
                In this test environment the code is delivered to the server
                logs — ask your administrator for the code, then{" "}
                <Link
                  href="/dashboard/reset-password"
                  className="text-cyan-400/80 hover:text-cyan-300"
                >
                  set a new password here
                </Link>
                .
              </p>
              <Link
                href="/dashboard/login"
                className="inline-block rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-cyan-400/40"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="mb-1.5 block text-xs font-medium text-slate-400"
                >
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
                {loading ? "Sending…" : "Send reset code"}
              </motion.button>
            </form>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-slate-600">
          <Link
            href="/dashboard/login"
            className="text-cyan-400/80 transition-colors hover:text-cyan-300"
          >
            Back to sign in
          </Link>
        </p>
      </motion.div>
    </main>
  );
}
