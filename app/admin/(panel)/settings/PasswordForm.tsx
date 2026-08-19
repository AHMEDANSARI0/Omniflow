"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "../../../../lib/supabase/client";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function PasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{
    success: boolean;
    text: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    if (password.length < 8) {
      setMessage({
        success: false,
        text: "Password must be at least 8 characters.",
      });
      return;
    }
    if (password !== confirm) {
      setMessage({ success: false, text: "Passwords do not match." });
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (error) {
      setMessage({
        success: false,
        text:
          error.message === "New password should be different from the old password."
            ? "New password must be different from the current one."
            : "Failed to update password. Please try again.",
      });
      return;
    }

    setPassword("");
    setConfirm("");
    setMessage({ success: true, text: "Password updated successfully." });
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
      <h2 className="mb-1 text-sm font-semibold text-white">Change password</h2>
      <p className="mb-5 text-xs text-slate-500">
        Use a strong password of at least 8 characters. You stay signed in
        after changing it.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="new_password" className={labelClass}>
              New password
            </label>
            <input
              id="new_password"
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>
          <div>
            <label htmlFor="confirm_password" className={labelClass}>
              Confirm new password
            </label>
            <input
              id="confirm_password"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-cyan-400 px-6 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity duration-300 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Updating…" : "Update password"}
          </button>

          {message && (
            <p
              className={`text-xs ${
                message.success ? "text-emerald-300" : "text-red-300"
              }`}
            >
              {message.text}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}