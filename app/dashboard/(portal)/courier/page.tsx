"use client";

import { useCallback, useEffect, useState } from "react";

interface CourierSettings {
  configured: boolean;
  enabled: boolean;
  provider: string;
  base_url: string;
  api_key_masked: string;
  api_password_masked: string;
  secret_label: string;
  providers: { id: string; label: string; default_base: string }[];
}

interface CourierBooking {
  id: number;
  tracking_number: string;
  provider: string;
  status: string;
  cod_amount: number;
  city: string;
  created_at: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  booked: "border-sky-400/25 bg-sky-400/[0.07] text-sky-300",
  in_transit: "border-amber-400/25 bg-amber-400/[0.07] text-amber-300",
  delivered: "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-300",
  returned: "border-rose-400/25 bg-rose-400/[0.07] text-rose-300",
  undelivered: "border-rose-400/25 bg-rose-400/[0.07] text-rose-300",
  cancelled: "border-white/[0.1] bg-white/[0.03] text-slate-400",
};

/**
 * Courier connector: the owner pastes their courier account's API
 * credentials here (provider + key + secret, base URL optional).
 * While credentials are missing everything stays in a clean
 * "not configured" state - the moment they save working ones and
 * enable the connector, booking and tracking go live. Includes a
 * Test button that pings the courier with the saved credentials.
 */
export default function CourierPage() {
  const [settings, setSettings] = useState<CourierSettings | null>(null);
  const [provider, setProvider] = useState("leopards");
  const [apiKey, setApiKey] = useState("");
  const [apiPassword, setApiPassword] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  const [bookForm, setBookForm] = useState({
    contact_id: "", customer_name: "", phone: "", city: "", address: "",
    cod_amount: "", description: "",
  });
  const [bookNote, setBookNote] = useState<string | null>(null);

  const [bookings, setBookings] = useState<CourierBooking[]>([]);
  const [busy, setBusy] = useState(false);

  const loadBookings = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/courier/bookings",
        { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as {
          bookings?: CourierBooking[];
        };
        setBookings(payload.bookings ?? []);
      }
    } catch {
      /* list keeps whatever it had */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/courier/settings",
          { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as CourierSettings;
          setSettings(payload);
          setProvider(payload.provider);
          setEnabled(payload.enabled);
        }
      } catch {
        /* empty states speak for themselves */
      }
    })();
    void loadBookings();
  }, [loadBookings]);

  async function saveSettings() {
    setBusy(true);
    setSaveNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/courier/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          api_key: apiKey,
          api_password: apiPassword,
          base_url: baseUrl,
          enabled,
        }),
      });
      if (response.ok) {
        const payload = (await response.json()) as { configured: boolean };
        setSaveNote(payload.configured
          ? "Saved - connector ready. Test kar ke dekh lein."
          : "Saved - credentials abhi mukammal nahi.");
        setApiKey("");
        setApiPassword("");
      } else {
        setSaveNote("Save failed.");
      }
    } catch {
      setSaveNote("Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setTestNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/courier/test",
        { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        { ok?: boolean; message?: string } | null;
      if (payload && typeof payload.ok === "boolean") {
        setTestNote((payload.ok ? "\u2713 " : "\u2717 ") + payload.message);
      } else {
        setTestNote("\u2717 Credentials save karein pehle.");
      }
    } catch {
      setTestNote("\u2717 Test failed - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function bookParcel() {
    if (!bookForm.city.trim() || !bookForm.address.trim()) return;
    setBusy(true);
    setBookNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/courier/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: bookForm.contact_id,
          customer_name: bookForm.customer_name,
          phone: bookForm.phone,
          city: bookForm.city,
          address: bookForm.address,
          cod_amount: Number(bookForm.cod_amount) || 0,
          description: bookForm.description,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        { tracking_number?: string; ask_prompts?: string[];
          error?: { message?: string } } | null;
      if (response.ok && payload?.tracking_number) {
        setBookNote("Booked \u2713 Tracking: " + payload.tracking_number
          + (payload.ask_prompts && payload.ask_prompts.length > 0
            ? " \u00b7 Address me kami: " + payload.ask_prompts.join(" ")
            : ""));
        setBookForm({ contact_id: "", customer_name: "", phone: "",
          city: "", address: "", cod_amount: "", description: "" });
        await loadBookings();
      } else {
        setBookNote(payload?.error?.message ?? "Booking failed.");
      }
    } catch {
      setBookNote("Booking failed.");
    } finally {
      setBusy(false);
    }
  }

  async function trackBooking(id: number) {
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/courier/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (response.ok) await loadBookings();
    } catch {
      /* keep list */
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Courier
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Apne courier account (Leopards / TCS) ko jorein - credentials
            yahan paste karein, Test chala kar confirm karein, phir
            booking aur tracking isi page se chalega.
          </p>
        </div>

        <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-white">Connector</p>
            {settings ? (
              <span
                className={
                  "rounded-full border px-2.5 py-1 text-[11px] " +
                  (settings.configured && settings.enabled
                    ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-200"
                    : "border-white/[0.1] bg-white/[0.03] text-slate-400")
                }
              >
                {settings.configured
                  ? (settings.enabled ? "Live" : "Saved (disabled)")
                  : "Not configured"}
              </span>
            ) : null}
          </div>

          {settings ? (
            <p className="mt-1 text-[11px] text-slate-500">
              {settings.api_key_masked
                ? "Saved: " + settings.api_key_masked
                : "Koi credentials saved nahi."}
            </p>
          ) : null}

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none"
            >
              {(settings?.providers ?? [{ id: "leopards",
                label: "Leopards Courier", default_base: "" }]).map(
                (p) => (
                  <option key={p.id} value={p.id} className="bg-[#0b1626]">
                    {p.label}
                  </option>
                )
              )}
            </select>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="API key"
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <input
              value={apiPassword}
              onChange={(event) => setApiPassword(event.target.value)}
              placeholder={
                (settings?.providers.find((p) => p.id === provider)
                  ?.default_base ? "API password / secret" : "API secret")
              }
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="Base URL (khali = default)"
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void saveSettings()}
              disabled={busy || !provider}
              className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => void testConnection()}
              disabled={busy}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.05] disabled:opacity-40"
            >
              Test connection
            </button>
            <button
              onClick={() => setEnabled(!enabled)}
              disabled={busy}
              className={
                "ml-auto rounded-full border px-3 py-1 text-[11px] " +
                (enabled
                  ? "border-emerald-400/40 bg-emerald-400/[0.12] text-emerald-200"
                  : "border-white/[0.08] bg-white/[0.02] text-slate-400")
              }
            >
              Connector: {enabled ? "on" : "off"}
            </button>
          </div>
          {saveNote ? (
            <p className="mt-1.5 text-[11px] text-slate-400">{saveNote}</p>
          ) : null}
          {testNote ? (
            <p className="mt-1.5 text-[11px] text-slate-300">{testNote}</p>
          ) : null}
        </section>

        <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
          <p className="text-xs font-semibold text-white">Book parcel</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            COD parcel book karein - tracking number foran milta he.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              value={bookForm.customer_name}
              onChange={(e) => setBookForm({ ...bookForm,
                customer_name: e.target.value })}
              placeholder="Customer name"
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <input
              value={bookForm.phone}
              onChange={(e) => setBookForm({ ...bookForm,
                phone: e.target.value })}
              placeholder="Phone"
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <input
              value={bookForm.city}
              onChange={(e) => setBookForm({ ...bookForm,
                city: e.target.value })}
              placeholder="City *"
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <input
              value={bookForm.cod_amount}
              onChange={(e) => setBookForm({ ...bookForm,
                cod_amount: e.target.value })}
              placeholder="COD amount"
              inputMode="decimal"
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <input
              value={bookForm.address}
              onChange={(e) => setBookForm({ ...bookForm,
                address: e.target.value })}
              placeholder="Address *"
              className="sm:col-span-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
          </div>
          <button
            onClick={() => void bookParcel()}
            disabled={busy || !bookForm.city.trim() || !bookForm.address.trim()}
            className="mt-2 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
          >
            Book parcel
          </button>
          {bookNote ? (
            <p className="mt-1.5 text-[11px] text-slate-300">{bookNote}</p>
          ) : null}
        </section>

        <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
          <p className="text-xs font-semibold text-white">Bookings</p>
          {bookings.length === 0 ? (
            <p className="mt-1 text-[11px] text-slate-500">
              Abhi koi booking nahi.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {bookings.map((booking) => (
                <li
                  key={booking.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs text-slate-200">
                      {booking.tracking_number || "(no CN)"}
                      <span className="ml-2 text-[11px] text-slate-500">
                        {booking.city}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      COD {booking.cod_amount} &middot; {booking.provider}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={
                        "rounded-full border px-2.5 py-1 text-[11px] " +
                        (STATUS_STYLES[booking.status] ??
                          STATUS_STYLES.in_transit)
                      }
                    >
                      {booking.status}
                    </span>
                    <button
                      onClick={() => void trackBooking(booking.id)}
                      disabled={busy}
                      className="text-[11px] text-cyan-300 hover:underline disabled:opacity-40"
                    >
                      Track
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
