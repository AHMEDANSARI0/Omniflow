"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";


type ChannelState = "disconnected" | "connecting" | "connected" | "unknown";

interface WhatsAppStatus {
  configured: boolean;
  state: ChannelState;
  accountName: string | null;
  phone: string | null;
  lastSeenAt: string | null;
}

const POLL_MS = 15_000;

const STATE_LABEL: Record<ChannelState, string> = {
  disconnected: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  unknown: "Checking…",
};

const STATE_DOT: Record<ChannelState, string> = {
  disconnected: "bg-slate-500",
  connecting: "bg-amber-400 of-pulse",
  connected: "bg-emerald-400",
  unknown: "bg-slate-500",
};

function formatLastSeen(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function WhatsAppChannelPage() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/channels/whatsapp", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as WhatsAppStatus | null;
      if (mounted.current && payload && "state" in payload) {
        setStatus(payload);
      }
    } catch {
      // Transient network issue — next poll will retry.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);

    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function runAction(action: "connect" | "disconnect") {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/channels/whatsapp", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        configured?: boolean;
        message?: string | null;
      } | null;
      if (payload && !payload.configured) {
        setNotice(
          "The connector module is not deployed on the server yet — pairing will activate automatically once it ships."
        );
      } else if (payload?.message) {
        setNotice(payload.message);
      }
      await refresh();
    } catch {
      setNotice("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-cyan-300 transition-colors hover:text-cyan-200"
          >
            Re-authenticate →
          </a>
        </div>
      </div>
    );
  }

  const state: ChannelState = status?.state ?? "unknown";
  const configured = status?.configured ?? false;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            WhatsApp channel
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Managed connector status for your workspace — authorize once from
            mobile, OmniFlow keeps the session available.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="shrink-0 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-400/40"
        >
          Refresh
        </button>
      </div>

      {!status ? (
        <div className="animate-pulse rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6">
          <div className="h-5 w-40 rounded bg-white/[0.06]" />
          <div className="mt-4 h-3 w-64 rounded bg-white/[0.04]" />
          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="h-16 rounded-xl bg-white/[0.03]" />
            <div className="h-16 rounded-xl bg-white/[0.03]" />
            <div className="h-16 rounded-xl bg-white/[0.03]" />
          </div>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6"
        >
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${STATE_DOT[state]}`} />
            <div>
              <p className="text-sm font-semibold text-white">{STATE_LABEL[state]}</p>
              <p className="text-[11px] text-slate-500">
                {configured ? "Live from Control Plane" : "Connector module pending on server"}
              </p>
            </div>
          </div>

          {state === "connected" && (
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Phone</p>
                <p className="mt-1 truncate text-sm text-slate-200">{status.phone || "—"}</p>
              </div>
              <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Account</p>
                <p className="mt-1 truncate text-sm text-slate-200">{status.accountName || "—"}</p>
              </div>
              <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Last seen</p>
                <p className="mt-1 truncate text-sm text-slate-200">{formatLastSeen(status.lastSeenAt)}</p>
              </div>
            </div>
          )}

          {state === "connecting" && (
            <p className="mt-5 text-xs leading-relaxed text-amber-300/90">
              Pairing in progress — scan the QR / enter the pairing code from your
              phone. This updates automatically.
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {state === "connected" ? (
              <button
                onClick={() => void runAction("disconnect")}
                disabled={busy}
                className="rounded-xl border border-red-400/25 bg-red-400/[0.06] px-4 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-400/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Working…" : "Disconnect"}
              </button>
            ) : (
              <button
                onClick={() => void runAction("connect")}
                disabled={busy || state === "connecting"}
                className="rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {state === "connecting" ? "Connecting…" : busy ? "Working…" : "Start pairing"}
              </button>
            )}
            {state === "disconnected" && configured && (
              <p className="text-xs text-slate-500">
                You will pair from your phone — WhatsApp stays on the managed connector, never in the browser.
              </p>
            )}
          </div>

          {notice && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.05] px-3 py-2 text-xs leading-relaxed text-cyan-200/90"
            >
              {notice}
            </motion.p>
          )}
        </motion.div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-slate-600">
        Status auto-refreshes every 15 seconds while this page is open. Session
        credentials stay in HttpOnly cookies.
      </p>
    </div>
  );
}
