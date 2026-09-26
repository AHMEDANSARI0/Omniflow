"use client";

import { useState } from "react";

export default function PayGate({
  token,
  due,
  phoneVerification,
  status,
}: {
  token: string;
  due: number | string;
  phoneVerification: boolean;
  status: string;
}) {
  const [verified, setVerified] = useState(false);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  if (status !== "open") return null;

  async function sendCode() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/public/checkout/" + encodeURIComponent(token) + "/otp",
        { method: "POST" }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setSent(true);
        setNote({ text: "Code sent to you on WhatsApp.", ok: true });
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not send the code — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not send the code — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setNote({ text: "Enter the 6-digit code.", ok: false });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/public/checkout/"
          + encodeURIComponent(token)
          + "/otp/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        verified?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.verified) {
        setVerified(true);
        setNote({ text: "Verified — you can pay now.", ok: true });
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not verify — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not verify — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  if (phoneVerification && !verified) {
    return (
      <div className="mt-3 rounded-xl border border-line bg-soft px-4 py-3">
        <p className="text-xs font-medium text-ink">
          Verify it&apos;s you before paying
        </p>
        <p className="mt-1 text-[11px] text-ink-3">
          We send a 6-digit code to your WhatsApp.
        </p>
        {sent ? (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              className="w-28 rounded-xl border border-line bg-soft px-3 py-2 text-sm tracking-[0.3em] text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none"
            />
            <button
              onClick={() => void verify()}
              disabled={busy}
              className="rounded-xl border border-brand/30 bg-brand-soft px-3 py-2 text-xs font-medium text-brand hover:bg-brand-soft disabled:opacity-50"
            >
              {busy ? "Checking…" : "Verify"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => void sendCode()}
            disabled={busy}
            className="mt-2 rounded-xl border border-brand/30 bg-brand-soft px-3 py-2 text-xs font-medium text-brand hover:bg-brand-soft disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send my code"}
          </button>
        )}
        {note ? (
          <p
            className={
              "mt-2 text-[11px] " + (note.ok ? "text-ok" : "text-danger")
            }
          >
            {note.text}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <a
      href={"/api/omniflow/public/checkout/" + encodeURIComponent(token) + "/pay"}
      className="mt-3 block rounded-xl border border-emerald-400/30 bg-emerald-400/[0.1] px-4 py-3 text-center text-sm font-semibold text-ok hover:bg-emerald-400/[0.18]"
    >
      Pay {due} online
    </a>
  );
}
