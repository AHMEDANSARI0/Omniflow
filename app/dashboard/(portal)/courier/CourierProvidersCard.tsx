"use client";

import { useCallback, useEffect, useState } from "react";

interface CourierProvider {
  id: number;
  name: string;
  adapter: string;
  base_url: string;
  api_key_masked: string;
  api_secret_masked: string;
  booking_mode: string;
  enabled: boolean;
  test_status: string;
  test_message: string;
  created_at: string;
}

interface CourierProviderAdapter {
  key: string;
  label: string;
  default_base: string;
  secret_label: string;
}

const MODE_HINTS: Record<string, string> = {
  auto: "The assistant books parcels by itself.",
  draft: "A draft is stored - a human reviews and confirms.",
  manual: "Nothing books until a human explicitly confirms.",
};

const EMPTY_FORM = {
  name: "",
  adapter: "",
  base_url: "",
  api_key: "",
  api_secret: "",
  booking_mode: "draft",
};

/**
 * Courier companies live here as data - the + button adds one (name,
 * adapter, credentials), Test proves the credentials, Connect puts it
 * in rotation. Nothing about the courier set is hardcoded: whatever
 * the owner adds is what the booking flow uses.
 */
export default function CourierProvidersCard() {
  const [providers, setProviders] = useState<CourierProvider[]>([]);
  const [adapters, setAdapters] = useState<CourierProviderAdapter[]>([]);
  const [modes, setModes] = useState<string[]>(["auto", "draft", "manual"]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/courier/providers",
        { cache: "no-store" }
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          providers?: CourierProvider[];
          adapters?: CourierProviderAdapter[];
          booking_modes?: string[];
        };
        setProviders(payload.providers ?? []);
        setAdapters(payload.adapters ?? []);
        if (payload.booking_modes?.length) setModes(payload.booking_modes);
      }
    } catch {
      /* the card keeps whatever it had */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addProvider() {
    if (!form.name.trim() || !form.adapter) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/courier/providers",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | { id?: number; error?: { message?: string } }
        | null;
      if (response.ok && payload?.id) {
        setForm({ ...EMPTY_FORM });
        setFormOpen(false);
        setNote("Added - now run a test, then connect it.");
        await load();
      } else {
        setNote(payload?.error?.message ?? "Could not add the courier.");
      }
    } catch {
      setNote("Could not add the courier - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function patchProvider(id: number, patch: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/courier/providers/" + id,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }
      );
      if (response.ok) await load();
      else setNote("Update refused - try again.");
    } catch {
      setNote("Update failed - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeProvider(id: number) {
    if (!window.confirm("Remove this courier company?")) return;
    setBusy(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/courier/providers/" + id,
        { method: "DELETE" }
      );
      if (response.ok) await load();
      else setNote("Delete refused - try again.");
    } catch {
      setNote("Delete failed - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function testProvider(id: number) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/courier/providers/" + id + "/test",
        { method: "POST" }
      );
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string }
        | null;
      setNote(payload?.message
        ? (payload.ok ? "\u2713 " : "\u2717 ") + payload.message
        : "\u2717 Test failed - save the credentials first.");
      await load();
    } catch {
      setNote("\u2717 Test failed - try again.");
    } finally {
      setBusy(false);
    }
  }

  const selectedAdapter = adapters.find((a) => a.key === form.adapter);

  return (
    <section className="rounded-2xl border border-line bg-soft p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-ink">
            Courier companies
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Add each courier once - credentials stay masked after save.
          </p>
        </div>
        <button
          onClick={() => setFormOpen(!formOpen)}
          aria-label="Add courier company"
          className="rounded-full border border-brand/30 bg-brand-soft px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand-soft"
        >
          + Add courier
        </button>
      </div>

      {formOpen ? (
        <div className="mt-3 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.03] p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Company name (e.g. Leopards Karachi)"
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <select
              value={form.adapter}
              onChange={(e) => setForm({ ...form,
                adapter: e.target.value,
                base_url: "" })}
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none"
            >
              <option value="" className="bg-white">
                Adapter type&hellip;
              </option>
              {adapters.map((adapter) => (
                <option key={adapter.key} value={adapter.key}
                  className="bg-white">
                  {adapter.label}
                </option>
              ))}
            </select>
            <input
              value={form.api_key}
              onChange={(e) => setForm({ ...form,
                api_key: e.target.value })}
              placeholder="API key"
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <input
              value={form.api_secret}
              onChange={(e) => setForm({ ...form,
                api_secret: e.target.value })}
              placeholder={selectedAdapter?.secret_label ?? "API secret"}
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            <input
              value={form.base_url}
              onChange={(e) => setForm({ ...form,
                base_url: e.target.value })}
              placeholder={
                selectedAdapter?.default_base
                  ? "Base URL (empty = " +
                    selectedAdapter.default_base + ")"
                  : "Base URL"
              }
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 sm:col-span-2"
            />
            <select
              value={form.booking_mode}
              onChange={(e) => setForm({ ...form,
                booking_mode: e.target.value })}
              className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none sm:col-span-2"
            >
              {modes.map((mode) => (
                <option key={mode} value={mode} className="bg-white">
                  Booking mode: {mode} &mdash; {MODE_HINTS[mode] ?? ""}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void addProvider()}
              disabled={busy || !form.name.trim() || !form.adapter}
              className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-xs text-ok hover:bg-emerald-400/[0.15] disabled:opacity-40"
            >
              Save courier
            </button>
            <button
              onClick={() => setFormOpen(false)}
              className="text-[11px] text-ink-3 hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {providers.length === 0 ? (
        <p className="mt-3 text-[11px] text-ink-3">
          No courier companies yet - add your first one with the + button.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="rounded-xl border border-line bg-soft p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs text-slate-100">
                    {provider.name}
                    <span className="ml-2 rounded-full border border-line-2 bg-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-3">
                      {provider.adapter}
                    </span>
                    {provider.enabled ? (
                      <span className="ml-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-[10px] text-ok">
                        Connected
                      </span>
                    ) : null}
                    {provider.test_status === "ok" ? (
                      <span className="ml-1.5 text-[10px] text-ok">
                        &#10003; test passed
                      </span>
                    ) : provider.test_status === "fail" ? (
                      <span className="ml-1.5 text-[10px] text-danger">
                        &#10007; test failed
                      </span>
                    ) : (
                      <span className="ml-1.5 text-[10px] text-ink-3">
                        not tested
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {provider.api_key_masked || "no key"}
                    {" \u00b7 "}
                    {provider.base_url || "default base URL"}
                    {" \u00b7 books: "}{provider.booking_mode}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => void testProvider(provider.id)}
                    disabled={busy}
                    className="rounded-lg border border-line bg-soft px-2.5 py-1 text-[11px] text-ink-2 hover:bg-soft disabled:opacity-40"
                  >
                    Test
                  </button>
                  <button
                    onClick={() => void patchProvider(provider.id,
                      { enabled: !provider.enabled })}
                    disabled={busy}
                    className={
                      "rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-40 " +
                      (provider.enabled
                        ? "border-line bg-soft text-ink-3 hover:bg-soft"
                        : "border-emerald-400/25 bg-emerald-400/[0.07] text-ok hover:bg-emerald-400/[0.15]")
                    }
                  >
                    {provider.enabled ? "Disconnect" : "Connect"}
                  </button>
                  <select
                    value={provider.booking_mode}
                    onChange={(e) => void patchProvider(provider.id,
                      { booking_mode: e.target.value })}
                    disabled={busy}
                    className="rounded-lg border border-line bg-soft px-1.5 py-1 text-[11px] text-ink-2 outline-none"
                    aria-label="Booking mode"
                  >
                    {modes.map((mode) => (
                      <option key={mode} value={mode}
                        className="bg-white">
                        {mode}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void removeProvider(provider.id)}
                    disabled={busy}
                    className="text-[11px] text-danger/80 hover:text-rose-200 disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {provider.test_message ? (
                <p className="mt-1 text-[10px] text-ink-3">
                  {provider.test_message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[10px] text-ink-3">
        Booking modes: auto books instantly, draft waits for a human
        confirm on the booking, manual needs an explicit confirm every
        time.
      </p>
      {note ? (
        <p className="mt-1.5 text-[11px] text-ink-2">{note}</p>
      ) : null}
    </section>
  );
}
