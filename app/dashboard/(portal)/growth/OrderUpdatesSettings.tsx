"use client";

import { useCallback, useEffect, useState } from "react";

interface NotifySettings {
  notifyEnabled: boolean;
  tplPaid: string;
  tplShipped: string;
  tplDelivered: string;
  cartEnabled: boolean;
  cartGap1: number;
  cartGap2: number;
  cartGap3: number;
  cartTpl1: string;
  cartTpl2: string;
  cartTpl3: string;
}

const EMPTY: NotifySettings = {
  notifyEnabled: true,
  tplPaid: "",
  tplShipped: "",
  tplDelivered: "",
  cartEnabled: false,
  cartGap1: 2,
  cartGap2: 24,
  cartGap3: 48,
  cartTpl1: "",
  cartTpl2: "",
  cartTpl3: "",
};

const FIELD_BASE =
  "mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-white/20 focus:outline-none";

export default function OrderUpdatesSettings() {
  const [settings, setSettings] = useState<NotifySettings>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/checkout/settings", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        settings?: Partial<NotifySettings>;
      } | null;
      const s = payload?.settings;
      if (!s) return;
      setSettings({
        notifyEnabled: s.notifyEnabled === true,
        tplPaid: typeof s.tplPaid === "string" ? s.tplPaid : "",
        tplShipped: typeof s.tplShipped === "string" ? s.tplShipped : "",
        tplDelivered: typeof s.tplDelivered === "string" ? s.tplDelivered : "",
        cartEnabled: s.cartEnabled === true,
        cartGap1: typeof s.cartGap1 === "number" ? s.cartGap1 : 2,
        cartGap2: typeof s.cartGap2 === "number" ? s.cartGap2 : 24,
        cartGap3: typeof s.cartGap3 === "number" ? s.cartGap3 : 48,
        cartTpl1: typeof s.cartTpl1 === "string" ? s.cartTpl1 : "",
        cartTpl2: typeof s.cartTpl2 === "string" ? s.cartTpl2 : "",
        cartTpl3: typeof s.cartTpl3 === "string" ? s.cartTpl3 : "",
      });
      setVisible(true);
    } catch {
      return;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/checkout/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          settings: {
            notify_enabled: settings.notifyEnabled,
            tpl_paid: settings.tplPaid.trim().slice(0, 500),
            tpl_shipped: settings.tplShipped.trim().slice(0, 500),
            tpl_delivered: settings.tplDelivered.trim().slice(0, 500),
            cart: {
              enabled: settings.cartEnabled,
              gap_1: settings.cartGap1,
              gap_2: settings.cartGap2,
              gap_3: settings.cartGap3,
              tpl_1: settings.cartTpl1.trim().slice(0, 500),
              tpl_2: settings.cartTpl2.trim().slice(0, 500),
              tpl_3: settings.cartTpl3.trim().slice(0, 500),
            },
          },
        }),
      });
      if (response.ok) {
        setNote(
          settings.cartEnabled
            ? "Saved. Order updates and cart recovery are active."
            : "Saved. Customers get these updates automatically."
        );
      } else if (response.status === 400) {
        setNote("Templates are capped at 500 characters.");
      } else {
        setNote("Could not save right now. Try again shortly.");
      }
    } catch {
      setNote("Could not save right now. Try again shortly.");
    } finally {
      setSaving(false);
    }
  }

  if (loaded && !visible) return null;

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Order status updates
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            When you mark a checkout link paid, shipped or delivered, the
            customer gets a WhatsApp update automatically.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.notifyEnabled}
          onClick={() =>
            setSettings((prev) => ({
              ...prev,
              notifyEnabled: !prev.notifyEnabled,
            }))
          }
          className={`rounded-lg border px-2.5 py-1 text-[11px] ${
            settings.notifyEnabled
              ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
              : "border-white/[0.08] bg-white/[0.02] text-slate-400"
          }`}
        >
          {settings.notifyEnabled ? "Updates on" : "Updates off"}
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-[11px] text-slate-400">Paid message</span>
          <textarea
            rows={3}
            value={settings.tplPaid}
            onChange={(event) =>
              setSettings((prev) => ({ ...prev, tplPaid: event.target.value }))
            }
            placeholder="Payment received for &apos;{title}&apos;. Thank you!"
            className={FIELD_BASE}
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-400">Shipped message</span>
          <textarea
            rows={3}
            value={settings.tplShipped}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                tplShipped: event.target.value,
              }))
            }
            placeholder="Your order &apos;{title}&apos; has shipped."
            className={FIELD_BASE}
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-400">Delivered message</span>
          <textarea
            rows={3}
            value={settings.tplDelivered}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                tplDelivered: event.target.value,
              }))
            }
            placeholder="Order &apos;{title}&apos; delivered. Thank you!"
            className={FIELD_BASE}
          />
        </label>
      </div>
      <p className="mt-2 text-[10px] text-slate-600">
        Use {"{name}"}, {"{title}"} and {"{total}"} as placeholders. Leave a
        box empty to use the default message.
      </p>

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-slate-100">
              Cart recovery
            </h4>
            <p className="mt-0.5 text-xs text-slate-500">
              Up to three automatic WhatsApp reminders for checkout links
              still open after each delay. Stops the moment a link is paid
              or cancelled.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.cartEnabled}
            onClick={() =>
              setSettings((prev) => ({
                ...prev,
                cartEnabled: !prev.cartEnabled,
              }))
            }
            className={`rounded-lg border px-2.5 py-1 text-[11px] ${
              settings.cartEnabled
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                : "border-white/[0.08] bg-white/[0.02] text-slate-400"
            }`}
          >
            {settings.cartEnabled ? "Recovery on" : "Recovery off"}
          </button>
        </div>

        {settings.cartEnabled ? (
          <>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:max-w-xs">
              <label className="block">
                <span className="text-[11px] text-slate-400">After (1)</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={settings.cartGap1}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      cartGap1: Number(event.target.value) || 0,
                    }))
                  }
                  className={FIELD_BASE}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-400">Then (2)</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={settings.cartGap2}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      cartGap2: Number(event.target.value) || 0,
                    }))
                  }
                  className={FIELD_BASE}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-400">Then (3)</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={settings.cartGap3}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      cartGap3: Number(event.target.value) || 0,
                    }))
                  }
                  className={FIELD_BASE}
                />
              </label>
            </div>
            <p className="mt-1 text-[10px] text-slate-600">
              Hours after the checkout link was created (1-168).
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="text-[11px] text-slate-400">
                  Reminder 1
                </span>
                <textarea
                  rows={3}
                  value={settings.cartTpl1}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      cartTpl1: event.target.value,
                    }))
                  }
                  placeholder="You left &apos;{title}&apos; ({total}) in your cart."
                  className={FIELD_BASE}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-400">
                  Reminder 2
                </span>
                <textarea
                  rows={3}
                  value={settings.cartTpl2}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      cartTpl2: event.target.value,
                    }))
                  }
                  placeholder="Still thinking about &apos;{title}&apos;?"
                  className={FIELD_BASE}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-400">
                  Reminder 3
                </span>
                <textarea
                  rows={3}
                  value={settings.cartTpl3}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      cartTpl3: event.target.value,
                    }))
                  }
                  placeholder="Last reminder for &apos;{title}&apos;."
                  className={FIELD_BASE}
                />
              </label>
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200 hover:bg-white/[0.08] disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {note ? <span className="text-[11px] text-slate-500">{note}</span> : null}
      </div>
    </section>
  );
}
