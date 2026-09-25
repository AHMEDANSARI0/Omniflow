"use client";

import { useCallback, useEffect, useState } from "react";
import type { CatalogItem, IndustryPreset } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";

const labelClass = "mb-1.5 block text-xs font-medium text-ink-3";

const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";

const ghostBtn =
  "rounded-xl border border-line bg-soft px-4 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:bg-soft disabled:opacity-50";

const chipClass =
  "rounded-md border border-line bg-soft px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-3";

interface ItemFormState {
  id: number | null;
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
}

const EMPTY_FORM: ItemFormState = {
  id: null,
  kind: "product",
  name: "",
  priceText: "",
  notes: "",
  isActive: true,
};

export default function CatalogSection() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [presets, setPresets] = useState<IndustryPreset[]>([]);
  const [industry, setIndustry] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<ItemFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/catalog", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        items?: CatalogItem[];
      } | null;
      if (payload && Array.isArray(payload.items)) {
        setItems(payload.items);
      }
    } catch {
      // Transient network issue — the next action retries.
    }
  }, []);

  useEffect(() => {
    let alive = true;

    async function loadAll() {
      try {
        const [catalogResponse, presetsResponse] = await Promise.all([
          fetch("/api/omniflow/portal/catalog", {
            credentials: "same-origin",
            cache: "no-store",
          }),
          fetch("/api/omniflow/portal/presets", {
            credentials: "same-origin",
            cache: "no-store",
          }),
        ]);
        if (!alive) return;
        if (catalogResponse.ok) {
          const payload = (await catalogResponse.json().catch(() => null)) as {
            items?: CatalogItem[];
          } | null;
          if (payload && Array.isArray(payload.items)) setItems(payload.items);
        }
        if (presetsResponse.ok) {
          const payload = (await presetsResponse.json().catch(() => null)) as {
            presets?: IndustryPreset[];
          } | null;
          if (payload && Array.isArray(payload.presets)) {
            setPresets(payload.presets);
            setIndustry(payload.presets[0]?.id ?? "");
          }
        }
      } catch {
        // Transient network issue — the next action retries.
      } finally {
        if (alive) setLoaded(true);
      }
    }

    void loadAll();
    return () => {
      alive = false;
    };
  }, []);

  async function applyPreset() {
    if (busy || !industry) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ industry }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        applied?: number;
        skipped?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text:
            "Starter pack loaded — " +
            String(payload.applied ?? 0) +
            " answers added to your knowledge base" +
            (payload.skipped
              ? " (" + String(payload.skipped) + " already existed)"
              : "") +
            ". Review them on the Knowledge base page.",
        });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not load the pack. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function saveForm() {
    if (busy || !form) return;
    const name = form.name.trim();
    if (!name) {
      setMessage({ kind: "error", text: "Name is required." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        form.id === null
          ? "/api/omniflow/portal/catalog"
          : "/api/omniflow/portal/catalog/" + String(form.id),
        {
          method: form.id === null ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            item: {
              kind: form.kind,
              name,
              priceText: form.priceText.trim(),
              notes: form.notes.trim(),
              isActive: form.isActive,
            },
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: form.id === null ? "Item added." : "Item updated.",
        });
        setForm(null);
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(itemId: number) {
    if (busy) return;
    if (!window.confirm("Delete this item from your catalog?")) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/" + String(itemId),
        {
          method: "DELETE",
          credentials: "same-origin",
        }
      );
      if (response.ok) {
        setMessage({ kind: "ok", text: "Item deleted." });
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: "Could not delete. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-line bg-soft p-6">
        <h2 className="text-sm font-semibold text-ink">Quick setup</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          Pick your business type and we will load proven starter answers
          (delivery, payments, policies) into your knowledge base. You can
          edit or remove them anytime.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <select
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            aria-label="Business type"
            className={inputClass + " sm:max-w-xs"}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — {preset.entryCount} answers
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => applyPreset()}
            disabled={busy || presets.length === 0}
            className={primaryBtn}
          >
            {busy ? "Loading..." : "Load starter pack"}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-soft p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              Products &amp; services
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">
              Your offering at a glance — what you sell and at what price.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setForm({ ...EMPTY_FORM });
              setMessage(null);
            }}
            className={primaryBtn}
          >
            Add item
          </button>
        </div>

        {message && (
          <div
            className={
              "mt-4 rounded-xl border px-4 py-3 text-xs leading-relaxed " +
              (message.kind === "ok"
                ? "border-emerald-400/20 bg-emerald-400/[0.05] text-ok/90"
                : "border-red-400/20 bg-red-400/[0.05] text-red-200/90")
            }
          >
            {message.text}
          </div>
        )}

        {form && (
          <div className="mt-4 rounded-2xl border border-cyan-400/15 bg-soft p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="itemKind" className={labelClass}>
                  Type
                </label>
                <select
                  id="itemKind"
                  value={form.kind}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kind: e.target.value === "service" ? "service" : "product",
                    })
                  }
                  className={inputClass}
                >
                  <option value="product">Product</option>
                  <option value="service">Service</option>
                </select>
              </div>
              <div>
                <label htmlFor="itemName" className={labelClass}>
                  Name
                </label>
                <input
                  id="itemName"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Lawn 3-piece suit"
                  className={inputClass}
                />
              </div>
            </div>
            <div className="mt-4">
              <label htmlFor="itemPrice" className={labelClass}>
                Price
              </label>
              <input
                id="itemPrice"
                type="text"
                value={form.priceText}
                onChange={(e) => setForm({ ...form, priceText: e.target.value })}
                placeholder="PKR 4,500 (negotiable)"
                className={inputClass}
              />
            </div>
            <div className="mt-4">
              <label htmlFor="itemNotes" className={labelClass}>
                Notes
              </label>
              <textarea
                id="itemNotes"
                rows={3}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Sizes S-XXL, 6 colours in stock..."
                className={inputClass}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-xs text-ink-3">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) =>
                    setForm({ ...form, isActive: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-white/20 bg-soft"
                />
                Active
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className={ghostBtn}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => saveForm()}
                  disabled={busy}
                  className={primaryBtn}
                >
                  {busy ? "Saving..." : "Save item"}
                </button>
              </div>
            </div>
          </div>
        )}

        {!loaded ? (
          <p className="mt-4 text-xs text-ink-3">Loading catalog...</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            No items yet — add your first product or service above.
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-line bg-white/[0.01] p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-ink">
                        {item.name}
                      </h3>
                      <span className={chipClass}>{item.kind}</span>
                      {!item.isActive && (
                        <span className="rounded-md border border-amber-400/20 bg-amber-400/[0.05] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-600/80">
                          Hidden
                        </span>
                      )}
                    </div>
                    {item.priceText && (
                      <p className="mt-1 text-xs text-ink-3">
                        {item.priceText}
                      </p>
                    )}
                    {item.notes && (
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                        {item.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setForm({
                          id: item.id,
                          kind: item.kind,
                          name: item.name,
                          priceText: item.priceText,
                          notes: item.notes,
                          isActive: item.isActive,
                        });
                        setMessage(null);
                      }}
                      className={ghostBtn}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      disabled={busy}
                      className="rounded-xl border border-red-400/15 bg-red-400/[0.04] px-4 py-2 text-xs font-medium text-danger/80 transition-colors duration-300 hover:bg-red-400/[0.09] disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
