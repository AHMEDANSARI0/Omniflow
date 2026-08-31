"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";


interface ClientUser {
  id: number;
  email: string;
  display_name: string | null;
  status: string | null;
  last_login_at: string | null;
  failed_attempt_count: number;
  locked: boolean;
}

interface ResetResult {
  email: string;
  temp_password: string;
}

interface ResetCode {
  user_id: number;
  email: string;
  code: string;
  expires_at: string;
  created_at: string;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function AdminCustomersPage() {
  const [users, setUsers] = useState<ClientUser[] | null>(null);
  const [resetCodes, setResetCodes] = useState<ResetCode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [clientsResponse, codesResponse] = await Promise.all([
        fetch("/api/omniflow/admin/clients", {
          credentials: "same-origin",
          cache: "no-store",
        }),
        fetch("/api/omniflow/admin/reset-codes", {
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);

      const clientsPayload = await clientsResponse.json().catch(() => null);
      if (!clientsResponse.ok) {
        setError(
          clientsPayload?.error?.message ??
            "Could not load clients. Please try again."
        );
        setUsers(null);
      } else {
        setUsers(
          Array.isArray(clientsPayload?.users) ? clientsPayload.users : []
        );
      }

      const codesPayload = await codesResponse.json().catch(() => null);
      setResetCodes(
        codesResponse.ok && Array.isArray(codesPayload?.codes)
          ? codesPayload.codes
          : []
      );
    } catch {
      setError("Network error — please try again.");
      setUsers(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resetPassword(userId: number, email: string) {
    if (
      !window.confirm(
        `Reset the password for client "${email}"?\n\nThe temporary password will be shown only once — copy it now.`
      )
    ) {
      return;
    }
    setBusyId(userId);
    setError(null);
    setResetResult(null);
    try {
      const response = await fetch(
        `/api/omniflow/admin/clients/${userId}/reset-password`,
        { method: "POST", credentials: "same-origin", cache: "no-store" }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Reset failed. Please try again.");
      } else {
        setResetResult({
          email: payload?.email ?? email,
          temp_password: payload?.temp_password ?? "",
        });
        await load();
      }
    } catch {
      setError("Network error — reset failed. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard may be unavailable — the user can still select the text.
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Customers
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Client accounts — password reset and lock status (Control Plane).
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-400/40"
        >
          Refresh
        </button>
      </div>

      {error && (
        <motion.p
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          role="alert"
          className="mb-4 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300"
        >
          {error}
        </motion.p>
      )}

      {resetResult && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.05] p-4"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-cyan-300">
            New temporary password — visible only once
          </p>
          <p className="mt-1 text-sm text-slate-300">{resetResult.email}</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 text-sm font-semibold tracking-wider text-white">
              {resetResult.temp_password}
            </code>
            <button
              onClick={() => void copyValue(resetResult.temp_password)}
              className="rounded-lg bg-cyan-400 px-3 py-2 text-xs font-semibold text-[#07111f] transition-opacity hover:opacity-90"
            >
              Copy
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Share this password with the client over a secure channel. They can
            change it after signing in.
          </p>
        </motion.div>
      )}

      {resetCodes && resetCodes.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.04] p-4"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-amber-300">
            Recent password reset codes — test phase
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            Shown here because email delivery (SMTP) is not configured yet.
            Codes expire in 10 minutes and die after a single use.
          </p>
          <div className="mt-3 space-y-2">
            {resetCodes.map((entry) => (
              <div
                key={`${entry.user_id}-${entry.created_at}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2"
              >
                <span className="text-xs text-slate-300">{entry.email}</span>
                <code className="rounded-md border border-white/[0.08] bg-black/40 px-2.5 py-1 text-xs font-semibold tracking-[0.3em] text-white">
                  {entry.code}
                </code>
                <button
                  onClick={() => void copyValue(entry.code)}
                  className="rounded-md bg-amber-400/90 px-2 py-1 text-[10px] font-semibold text-[#07111f] transition-opacity hover:opacity-90"
                >
                  Copy
                </button>
                <span className="ml-auto text-[10px] text-slate-500">
                  expires {formatDate(entry.expires_at)}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            Loading clients…
          </div>
        ) : !users || users.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            No clients found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last login</th>
                  <th className="px-4 py-3 font-medium">Failed</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-white/[0.04] last:border-0"
                  >
                    <td className="px-4 py-3 text-slate-200">{u.email}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {u.display_name || "—"}
                    </td>
                    <td className="px-4 py-3">
                      {u.locked ? (
                        <span className="rounded-md border border-red-400/25 bg-red-400/[0.07] px-2 py-0.5 text-[11px] font-medium text-red-300">
                          Locked
                        </span>
                      ) : (
                        <span className="rounded-md border border-emerald-400/20 bg-emerald-400/[0.06] px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                          {u.status || "Ok"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {formatDate(u.last_login_at)}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {u.failed_attempt_count}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => void resetPassword(u.id, u.email)}
                        disabled={busyId === u.id}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] px-3 py-1.5 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-400/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busyId === u.id ? "Resetting…" : "Reset password"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
