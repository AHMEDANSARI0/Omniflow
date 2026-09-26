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
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-5 py-10">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[640px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.07)_0%,transparent_70%)]" />
      <div className="pointer-events-none absolute -bottom-40 left-1/4 h-72 w-96 rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.06)_0%,transparent_70%)]" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-brand/20 bg-brand-soft">
            <span className="of-pulse h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]" />
          </div>
          <h1 className="text-xl font-semibold tracking-[-0.03em] text-ink">
            Omni<span className="text-brand">Flow</span>
          </h1>
          <p className="mt-1.5 text-xs uppercase tracking-widest text-ink-3">
            Reset password
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-soft p-6 sm:p-7">
          {done ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-ink-2">
                If this email is registered, a 6-digit reset code has been
                generated.
              </p>
              <p className="text-xs leading-relaxed text-ink-3">
                In this test environment the code is delivered to the server
                logs — ask your administrator for the code, then{" "}
                <Link
                  href="/dashboard/reset-password"
                  className="text-brand/80 hover:text-brand"
                >
                  set a new password here
                </Link>
                .
              </p>
              <Link
                href="/dashboard/login"
                className="inline-block rounded-xl border border-line bg-soft px-4 py-2.5 text-sm text-ink-2 transition-colors hover:border-brand/40"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="mb-1.5 block text-xs font-medium text-ink-3"
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
                  className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40"
                  placeholder="you@business.com"
                />
              </div>

              {error && (
                <motion.p
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  role="alert"
                  aria-live="polite"
                  className="rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-danger"
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

        <p className="mt-5 text-center text-xs text-ink-3">
          <Link
            href="/dashboard/login"
            className="text-brand/80 transition-colors hover:text-brand"
          >
            Back to sign in
          </Link>
        </p>
      </motion.div>
    </main>
  );
}
