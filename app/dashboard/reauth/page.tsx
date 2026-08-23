"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { refreshSessionCoordinated } from "../../../lib/omniflow/client-session";


export default function DashboardReauthenticationPage() {
  const router = useRouter();
  const started = useRef(false);
  const [message, setMessage] = useState("Refreshing your secure session…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    void refreshSessionCoordinated().then((ok) => {
      if (cancelled) return;
      if (ok) {
        router.replace("/dashboard");
        router.refresh();
      } else {
        setMessage("Your session ended. Redirecting to sign in…");
        window.setTimeout(() => router.replace("/dashboard/login"), 700);
      }
    }).catch(() => {
      if (cancelled) return;
      setMessage("Session service is temporarily unavailable. Please retry.");
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#07111f] px-5">
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.07] bg-white/[0.02] p-7 text-center">
        <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06]">
          <span className="of-pulse h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]" />
        </div>
        <h1 className="text-base font-semibold text-white">OmniFlow session</h1>
        <p className="mt-2 text-sm text-slate-400" aria-live="polite">
          {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-xl border border-white/[0.1] px-4 py-2 text-xs text-slate-300 transition-colors hover:border-cyan-400/30 hover:text-white"
        >
          Retry
        </button>
      </div>
    </main>
  );
}
