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
    <main className="flex min-h-screen items-center justify-center bg-canvas px-5">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-soft p-7 text-center">
        <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-brand/20 bg-brand-soft">
          <span className="of-pulse h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.7)]" />
        </div>
        <h1 className="text-base font-semibold text-ink">OmniFlow session</h1>
        <p className="mt-2 text-sm text-ink-3" aria-live="polite">
          {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-xl border border-line-2 px-4 py-2 text-xs text-ink-2 transition-colors hover:border-brand/30 hover:text-ink"
        >
          Retry
        </button>
      </div>
    </main>
  );
}
