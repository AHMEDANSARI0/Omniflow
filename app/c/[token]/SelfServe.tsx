"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "coupon" | "address" | "cancel";

export default function SelfServe({
  token,
  status,
  hasCoupon,
}: {
  token: string;
  status: string;
  hasCoupon: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState<"ok" | "error">("ok");

  const open = status === "open";

  async function applyCoupon() {
    if (busy || !code.trim()) {
      if (!code.trim()) {
        setNoteTone("error");
        setNote("Enter a coupon code first.");
      }
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/public/checkout/" + encodeURIComponent(token) + "/coupon",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setNoteTone("ok");
        setNote("Coupon applied — the new total is shown above.");
        setMode(null);
        router.refresh();
        return;
      }
      setNoteTone("error");
      setNote(payload?.error?.message || "This coupon code is not valid.");
    } catch {
      setNoteTone("error");
      setNote("Could not apply the coupon - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeCoupon() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/public/checkout/" + encodeURIComponent(token) + "/coupon",
        { method: "DELETE" }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setNoteTone("ok");
        setNote("Coupon removed.");
        router.refresh();
        return;
      }
      setNoteTone("error");
      setNote(payload?.error?.message || "Could not remove the coupon.");
    } catch {
      setNoteTone("error");
      setNote("Could not remove the coupon - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitRequest(kind: "address" | "cancel") {
    if (busy) return;
    if (kind === "address" && !address.trim()) {
      setNoteTone("error");
      setNote("Type the correct delivery address first.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/public/checkout/" + encodeURIComponent(token) + "/change-request",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            message: message.trim(),
            address_text: address.trim(),
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setNoteTone("ok");
        setNote(
          kind === "address"
            ? "Request sent — the business will confirm your new address on WhatsApp."
            : "Cancellation request sent — the business will confirm on WhatsApp."
        );
        setAddress("");
        setMessage("");
        setMode(null);
        return;
      }
      setNoteTone("error");
      setNote(payload?.error?.message || "Could not send the request.");
    } catch {
      setNoteTone("error");
      setNote("Could not send the request - try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-soft p-3">
      {mode === null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {open ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setMode("coupon");
                  setNote("");
                }}
                className="rounded-lg border border-brand/25 bg-cyan-400/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-brand hover:bg-brand-soft"
              >
                Have a coupon code?
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("address");
                  setNote("");
                }}
                className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-ink-2 hover:bg-white/[0.06]"
              >
                Change address
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("cancel");
                  setNote("");
                }}
                className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-ink-3 hover:border-rose-400/40 hover:text-danger"
              >
                Cancel order
              </button>
            </>
          ) : null}
          {hasCoupon ? (
            <button
              type="button"
              onClick={() => void removeCoupon()}
              disabled={busy}
              className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-ink-3 hover:bg-white/[0.06] disabled:opacity-50"
            >
              Remove coupon
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === "coupon" ? (
        <div className="flex items-center gap-1.5">
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="COUPON CODE"
            maxLength={24}
            className="w-full rounded-lg border border-line bg-soft px-3 py-2 text-xs uppercase text-ink outline-none focus:border-brand/40"
          />
          <button
            type="button"
            onClick={() => void applyCoupon()}
            disabled={busy}
            className="shrink-0 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-xs font-medium text-brand disabled:opacity-50"
          >
            {busy ? "…" : "Apply"}
          </button>
          <button
            type="button"
            onClick={() => setMode(null)}
            className="shrink-0 rounded-lg border border-line px-2 py-2 text-xs text-ink-3"
          >
            ✕
          </button>
        </div>
      ) : null}

      {mode === "address" ? (
        <div className="space-y-2">
          <textarea
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Your correct delivery address (house, street, area, city)"
            className="w-full resize-none rounded-lg border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
          />
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={500}
            placeholder="Note for the business (optional)"
            className="w-full rounded-lg border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void submitRequest("address")}
              disabled={busy}
              className="rounded-lg border border-brand/30 bg-brand-soft px-3 py-1.5 text-xs font-medium text-brand disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send address change"}
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-3"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {mode === "cancel" ? (
        <div className="space-y-2">
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={500}
            placeholder="Reason (optional)"
            className="w-full rounded-lg border border-line bg-soft px-3 py-2 text-xs text-ink outline-none focus:border-brand/40"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void submitRequest("cancel")}
              disabled={busy}
              className="rounded-lg border border-rose-400/30 bg-rose-400/[0.08] px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-400/[0.15] disabled:opacity-50"
            >
              {busy ? "Sending…" : "Request cancellation"}
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-3"
            >
              Back
            </button>
          </div>
          <p className="text-[10px] text-ink-3">
            The business reviews every request — nothing is cancelled
            automatically.
          </p>
        </div>
      ) : null}

      {note ? (
        <p
          className={
            "mt-2 text-[11px] " +
            (noteTone === "ok" ? "text-ok" : "text-danger")
          }
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}
