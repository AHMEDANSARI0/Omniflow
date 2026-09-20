"use client";

import { useCallback, useEffect, useState } from "react";

interface CatalogRow {
  id: number;
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
}

interface FormState {
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  kind: "product",
  name: "",
  priceText: "",
  notes: "",
};

export default function CatalogCard() {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState(0);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/catalog", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as {
        items?: CatalogRow[];
      } | null;
      if (payload && Array.isArray(payload.items)) setRows(payload.items);
    } catch {
      // transient - the list can be reloaded
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (busy) return;
    if (!form.name.trim()) {
      setNote("Item name is required.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: {
            kind: form.kind,
            name: form.name.trim(),
            price_text: form.priceText.trim(),
            notes: form.notes.trim(),
            is_active: true,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote(payload?.error?.message || "Could not save the item.");
        return;
      }
      setForm(EMPTY_FORM);
      setNote("Item saved.");
      await load();
    } catch {
      setNote("Could not save the item - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: number) {
    if (busy) return;
    if (!editForm.name.trim()) {
      setNote("Item name is required.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/" + String(id),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item: {
              kind: editForm.kind,
              name: editForm.name.trim(),
              price_text: editForm.priceText.trim(),
              notes: editForm.notes.trim(),
              is_active: true,
            },
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote(payload?.error?.message || "Could not update the item.");
        return;
      }
      setEditingId(0);
      setNote("Item updated.");
      await load();
    } catch {
      setNote("Could not update the item - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/" + String(id),
        { method: "DELETE" }
      );
      if (!response.ok) {
        setNote("Could not remove the item.");
        return;
      }
      setNote("Item removed.");
      await load();
    } catch {
      setNote("Could not remove the item - try again.");
    } finally {
      setBusy(false);
    }
  }

  const active = rows.filter((row) => row.isActive);

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
      <h2 className="text-sm font-semibold text-white">Saved catalog</h2>
      <p className="mt-1 text-xs text-slate-500">
        Products and services you sell again and again. The checkout link
        builder picks items from here with one tap, and recommendations read
        the same list.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-[7rem_1fr_9rem]">
        <select
          value={form.kind}
          onChange={(event) =>
            setForm({ ...form, kind: event.target.value === "service" ? "service" : "product" })
          }
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        >
          <option value="product">Product</option>
          <option value="service">Service</option>
        </select>
        <input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="Item name (e.g. Lawn 3-piece)"
          maxLength={120}
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        />
        <input
          value={form.priceText}
          onChange={(event) => setForm({ ...form, priceText: event.target.value })}
          placeholder="Price (e.g. Rs 2,500)"
          maxLength={40}
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={form.notes}
          onChange={(event) => setForm({ ...form, notes: event.target.value })}
          placeholder="Short note (optional)"
          maxLength={160}
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="shrink-0 rounded-xl bg-cyan-400 px-4 py-2 text-xs font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Add item
        </button>
      </div>

      {note ? <p className="mt-2 text-[11px] text-amber-300">{note}</p> : null}

      <div className="mt-4">
        {loaded && rows.length === 0 ? (
          <p className="text-xs text-slate-500">
            No catalog items yet — add your first product above.
          </p>
        ) : null}
        {active.length > 0 ? (
          <ul className="space-y-1.5">
            {active.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
              >
                {editingId === row.id ? (
                  <div className="grid gap-2 sm:grid-cols-[7rem_1fr_9rem]">
                    <select
                      value={editForm.kind}
                      onChange={(event) =>
                        setEditForm({
                          ...editForm,
                          kind: event.target.value === "service" ? "service" : "product",
                        })
                      }
                      className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
                    >
                      <option value="product">Product</option>
                      <option value="service">Service</option>
                    </select>
                    <input
                      value={editForm.name}
                      onChange={(event) =>
                        setEditForm({ ...editForm, name: event.target.value })
                      }
                      maxLength={120}
                      className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
                    />
                    <input
                      value={editForm.priceText}
                      onChange={(event) =>
                        setEditForm({ ...editForm, priceText: event.target.value })
                      }
                      maxLength={40}
                      className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
                    />
                    <div className="flex items-center gap-1.5 sm:col-span-3">
                      <button
                        type="button"
                        onClick={() => void saveEdit(row.id)}
                        disabled={busy}
                        className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.1] px-2.5 py-1 text-[10px] font-medium text-cyan-200 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(0)}
                        className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-[10px] text-slate-400"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-slate-200">
                        <span className="mr-1.5 rounded border border-white/[0.08] px-1 py-0.5 text-[9px] uppercase tracking-wider text-slate-400">
                          {row.kind}
                        </span>
                        {row.name}
                        {row.priceText ? (
                          <span className="text-slate-400"> · {row.priceText}</span>
                        ) : null}
                      </p>
                      {row.notes ? (
                        <p className="truncate text-[10px] text-slate-500">{row.notes}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(row.id);
                          setEditForm({
                            kind: row.kind,
                            name: row.name,
                            priceText: row.priceText,
                            notes: row.notes,
                          });
                        }}
                        className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(row.id)}
                        disabled={busy}
                        className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400 hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
