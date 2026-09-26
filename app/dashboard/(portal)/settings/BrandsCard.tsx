"use client";

import { useCallback, useEffect, useState } from "react";

interface Brand {
  id: number;
  name: string;
  slug: string | null;
  isActive: boolean;
}

/**
 * Settings -> Brands (multi-brand prep): name the businesses this
 * workspace sells under. Knowledge-base entries, catalog items and
 * checkout links can then carry a brand tag; untagged rows behave
 * exactly as before.
 */
export default function BrandsCard() {
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/brands", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as { brands?: Brand[] };
        setBrands(Array.isArray(payload.brands) ? payload.brands : []);
      } else {
        setBrands([]);
      }
    } catch {
      setBrands([]);
      setNote("Could not load brands - try again.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addBrand() {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean }),
      });
      if (response.ok) {
        setName("");
        await load();
      } else if (response.status === 409) {
        setNote("A brand with this name already exists.");
      } else if (response.status === 409) {
        setNote("Plan limit reached - manage plans in Settings.");
      } else {
        setNote("Could not add the brand - try again.");
      }
    } catch {
      setNote("Could not add the brand - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function patchBrand(
    id: number,
    changes: { name?: string; isActive?: boolean }
  ) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/brands/" + String(id),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changes),
        }
      );
      if (!response.ok) {
        setNote("Could not save - try again.");
      }
      await load();
    } catch {
      setNote("Could not save - try again.");
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  }

  async function removeBrand(id: number) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/brands/" + String(id),
        { method: "DELETE" }
      );
      if (!response.ok) {
        setNote("Could not remove the brand - try again.");
      }
      await load();
    } catch {
      setNote("Could not remove the brand - try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <p className="text-xs font-semibold text-white">Brands</p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Name the businesses you sell under. Optional today - knowledge-base
        entries, catalog items and checkout links can carry a brand tag.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addBrand();
          }}
          placeholder="e.g. House of Linen"
          maxLength={60}
          className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void addBrand()}
          disabled={busy || !name.trim()}
          className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-3.5 py-2 text-xs font-medium text-cyan-200 transition-colors duration-200 hover:bg-cyan-400/[0.14] disabled:opacity-40"
        >
          Add brand
        </button>
      </div>

      {note ? (
        <p className="mt-2 text-[11px] text-amber-300">{note}</p>
      ) : null}

      {brands === null ? (
        <div className="mt-3 space-y-2" aria-busy="true">
          {[0, 1].map((row) => (
            <div
              key={row}
              className="h-9 animate-pulse rounded-lg bg-white/5"
            />
          ))}
        </div>
      ) : brands.length === 0 ? (
        <p className="mt-3 text-[11px] text-slate-600">
          No brands yet - everything stays untagged until you add one.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {brands.map((brand) => (
            <li
              key={brand.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2"
            >
              {renaming === brand.id ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    maxLength={60}
                    className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-white focus:border-cyan-400/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy || !renameValue.trim()}
                    onClick={() =>
                      void patchBrand(brand.id, { name: renameValue.trim() })
                    }
                    className="text-[11px] text-cyan-300 disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenaming(null)}
                    className="text-[11px] text-slate-500"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-slate-200">
                      {brand.name}
                    </span>
                    <span
                      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
                        brand.isActive
                          ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                          : "border-white/[0.08] bg-white/[0.02] text-slate-500"
                      }`}
                    >
                      {brand.isActive ? "Active" : "Paused"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px]">
                    {brand.slug ? (
                      <a
                        href={"/store/" + brand.slug}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400/80 transition-colors duration-200 hover:text-cyan-300"
                        title={"Open the " + brand.name + " store page"}
                      >
                        Store
                      </a>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setRenaming(brand.id);
                        setRenameValue(brand.name);
                      }}
                      className="text-slate-500 transition-colors duration-200 hover:text-slate-300"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void patchBrand(brand.id, {
                          isActive: !brand.isActive,
                        })
                      }
                      className="text-slate-500 transition-colors duration-200 hover:text-slate-300 disabled:opacity-40"
                    >
                      {brand.isActive ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeBrand(brand.id)}
                      className="text-rose-400/80 transition-colors duration-200 hover:text-rose-300 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
