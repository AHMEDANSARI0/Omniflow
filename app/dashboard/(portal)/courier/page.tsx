"use client";

import { useCallback, useEffect, useState } from "react";

import CourierProvidersCard from "./CourierProvidersCard";

interface CourierProvider {
  id: number;
  name: string;
  booking_mode: string;
  enabled: boolean;
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
  draft: "border-violet-400/25 bg-violet-400/[0.07] text-ai",
  in_transit: "border-amber-400/25 bg-amber-400/[0.07] text-amber-600",
  delivered: "border-emerald-400/25 bg-emerald-400/[0.07] text-ok",
  returned: "border-rose-400/25 bg-rose-400/[0.07] text-danger",
  undelivered: "border-rose-400/25 bg-rose-400/[0.07] text-danger",
  cancelled: "border-line-2 bg-soft text-ink-3",
};

const EMPTY_BOOK = {
  contact_id: "", customer_name: "", phone: "", city: "", address: "",
  cod_amount: "", description: "",
};

/**
 * Courier operations: providers are data rows (add, test, connect
 * above); the booking form uses whichever connected provider is
 * active. Hybrid booking honors each provider's mode - auto books
 * instantly, draft/manual queue a draft that a human confirms below.
 */
export default function CourierPage() {
  const [providers, setProviders] = useState<CourierProvider[]>([]);
  const [providerId, setProviderId] = useState(0);
  const [bookForm, setBookForm] = useState({ ...EMPTY_BOOK });
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

  const loadProviders = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/courier/providers",
        { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as {
          providers?: CourierProvider[];
        };
        const enabled = (payload.providers ?? []).filter(
          (provider) => provider.enabled
        );
        setProviders(enabled);
        setProviderId((current) =>
          enabled.some((provider) => provider.id === current)
            ? current
            : 0
        );
      }
    } catch {
      /* empty select means: default provider */
    }
  }, []);

  useEffect(() => {
    void loadBookings();
    void loadProviders();
  }, [loadBookings, loadProviders]);

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
          provider_id: providerId || undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { tracking_number?: string; draft?: boolean;
            ask_prompts?: string[]; error?: { message?: string } }
        | null;
      if (response.ok && payload?.draft) {
        setBookNote("Draft stored - review and confirm it below.");
        setBookForm({ ...EMPTY_BOOK });
        await loadBookings();
      } else if (response.ok && payload?.tracking_number) {
        setBookNote("Booked \u2713 Tracking: " + payload.tracking_number
          + (payload.ask_prompts && payload.ask_prompts.length > 0
            ? " \u00b7 Address gaps: " + payload.ask_prompts.join(" ")
            : ""));
        setBookForm({ ...EMPTY_BOOK });
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

  async function confirmDraft(id: number) {
    setBusy(true);
    setBookNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/courier/bookings/" + id + "/confirm",
        { method: "POST" }
      );
      const payload = (await response.json().catch(() => null)) as
        | { tracking_number?: string; error?: { message?: string } }
        | null;
      if (response.ok && payload?.tracking_number) {
        setBookNote("Confirmed \u2713 Tracking: "
          + payload.tracking_number);
        await loadBookings();
      } else {
        setBookNote(payload?.error?.message ?? "Confirm failed.");
      }
    } catch {
      setBookNote("Confirm failed - try again.");
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
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-brand/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Courier
          </h1>
          <p className="mt-1.5 text-sm text-ink-3">
            Connect your courier accounts, then book or track parcels
            right from this page - with as much automation as you
            allow.
          </p>
        </div>

        <CourierProvidersCard />

        <section className="mt-4 rounded-2xl border border-line bg-soft p-4">
          <p className="text-xs font-semibold text-ink">Book parcel</p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {providers.length === 0
              ? "Connect a courier above first - then book here."
              : "Books through the selected courier - drafts land in the list below when the mode asks for a confirm."}
          </p>
          {providers.length > 0 ? (
            <select
              value={providerId}
              onChange={(event) =>
                setProviderId(Number(event.target.value) || 0)}
              className="mt-2 w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none sm:w-auto"
              aria-label="Courier company"
            >
              <option value={0} className="bg-white">
                Default courier
              </option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}
                  className="bg-white">
                  {provider.name} ({provider.booking_mode})
                </option>
              ))}
            </select>
          ) : null}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              value={bookForm.customer_name}
              onChange={(e) => setBookForm({ ...bookForm,
                customer_name: e.target.value })}
              placeholder="Customer name"
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <input
              value={bookForm.phone}
              onChange={(e) => setBookForm({ ...bookForm,
                phone: e.target.value })}
              placeholder="Phone"
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <input
              value={bookForm.city}
              onChange={(e) => setBookForm({ ...bookForm,
                city: e.target.value })}
              placeholder="City *"
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <input
              value={bookForm.cod_amount}
              onChange={(e) => setBookForm({ ...bookForm,
                cod_amount: e.target.value })}
              placeholder="COD amount"
              inputMode="decimal"
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <input
              value={bookForm.address}
              onChange={(e) => setBookForm({ ...bookForm,
                address: e.target.value })}
              placeholder="Address *"
              className="sm:col-span-2 rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
          </div>
          <button
            onClick={() => void bookParcel()}
            disabled={busy || providers.length === 0
              || !bookForm.city.trim() || !bookForm.address.trim()}
            className="mt-2 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-40"
          >
            Book parcel
          </button>
          {bookNote ? (
            <p className="mt-1.5 text-[11px] text-ink-2">{bookNote}</p>
          ) : null}
        </section>

        <section className="mt-4 rounded-2xl border border-line bg-soft p-4">
          <p className="text-xs font-semibold text-ink">Bookings</p>
          {bookings.length === 0 ? (
            <p className="mt-1 text-[11px] text-ink-3">
              No bookings yet.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {bookings.map((booking) => (
                <li
                  key={booking.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-soft px-3 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs text-ink">
                      {booking.tracking_number || "(no CN)"}
                      <span className="ml-2 text-[11px] text-ink-3">
                        {booking.city}
                      </span>
                    </p>
                    <p className="text-[11px] text-ink-3">
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
                    {booking.status === "draft" ? (
                      <button
                        onClick={() => void confirmDraft(booking.id)}
                        disabled={busy}
                        className="text-[11px] text-violet-200 hover:underline disabled:opacity-40"
                      >
                        Confirm
                      </button>
                    ) : (
                      <button
                        onClick={() => void trackBooking(booking.id)}
                        disabled={busy}
                        className="text-[11px] text-brand hover:underline disabled:opacity-40"
                      >
                        Track
                      </button>
                    )}
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
