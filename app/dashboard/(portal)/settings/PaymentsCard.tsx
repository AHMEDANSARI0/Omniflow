"use client";

import { useEffect, useState } from "react";

type PaymentSettings = {
  provider: string;
  enabled: boolean;
  sandbox: boolean;
  configured: boolean;
  merchantIdMask: string;
  storeIdMask: string;
};

export default function PaymentsCard() {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [provider, setProvider] = useState("jazzcash");
  const [enabled, setEnabled] = useState(false);
  const [sandbox, setSandbox] = useState(true);
  const [merchantId, setMerchantId] = useState("");
  const [password, setPassword] = useState("");
  const [salt, setSalt] = useState("");
  const [storeId, setStoreId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/omniflow/portal/payments/settings", {
      cache: "no-store",
    })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (!active || payload === null || payload.settings === undefined) {
          return;
        }
        const data = payload.settings as PaymentSettings;
        setSettings(data);
        setProvider(data.provider || "jazzcash");
        setEnabled(data.enabled);
        setSandbox(data.sandbox);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/payments/settings",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            enabled,
            sandbox,
            merchant_id: merchantId,
            password,
            salt,
            store_id: storeId,
          }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not save.");
        return;
      }
      if (!response.ok) {
        setNote("Could not save - try again.");
        return;
      }
      setMerchantId("");
      setPassword("");
      setSalt("");
      setStoreId("");
      setNote("Saved.");
      const fresh = await fetch("/api/omniflow/portal/payments/settings", {
        cache: "no-store",
      })
        .then((response) => response.json().catch(() => null))
        .catch(() => null);
      if (fresh && fresh.settings) setSettings(fresh.settings);
    } catch {
      setNote("Could not save - try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 focus:border-white/20 focus:outline-none";

  return (
    <section className="mt-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-slate-200">
            Online payments
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            JazzCash / Easypaisa hosted checkout on your order links. The
            customer pays from the link; the payment lands on the order
            automatically.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
      </div>

      {settings ? (
        <p className="mt-2 text-[11px] text-slate-500">
          {settings.configured
            ? "Configured" + (settings.sandbox ? " (sandbox)" : "") +
              " - merchant " + settings.merchantIdMask +
              ", store " + settings.storeIdMask
            : "Not configured yet."}
        </p>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-slate-400">Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className={inputClass}
          >
            <option value="jazzcash">JazzCash</option>
            <option value="easypaisa">Easypaisa</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={sandbox}
            onChange={(event) => setSandbox(event.target.checked)}
          />
          Sandbox (test mode)
        </label>
        {provider === "jazzcash" ? (
          <>
            <label className="block">
              <span className="text-[11px] text-slate-400">Merchant ID</span>
              <input
                type="text"
                value={merchantId}
                onChange={(event) => setMerchantId(event.target.value)}
                placeholder={settings?.merchantIdMask || "MC-12345"}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">
                Integration password
              </span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block col-span-2">
              <span className="text-[11px] text-slate-400">
                Integrity salt
              </span>
              <input
                type="password"
                value={salt}
                onChange={(event) => setSalt(event.target.value)}
                className={inputClass}
              />
            </label>
          </>
        ) : (
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Store ID</span>
            <input
              type="text"
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              placeholder={settings?.storeIdMask || "STORE-1"}
              className={inputClass}
            />
          </label>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.08] px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/[0.15] disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save payment settings"}
        </button>
        {note ? (
          <span className="text-[11px] text-slate-400">{note}</span>
        ) : null}
      </div>
    </section>
  );
}
