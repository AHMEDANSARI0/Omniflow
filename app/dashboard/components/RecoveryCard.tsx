"use client";

import { useCallback, useEffect, useState } from "react";

interface RecoveryItem {
  id: number;
  kind: string;
  contact_id: string;
  conversation_id: number | null;
  priority: number;
  status: string;
  note: string;
  created_at: string | null;
}

const KIND_LABEL: Record<string, string> = {
  abandoned_checkout: "Abandoned checkout",
  unconfirmed_cod: "COD unconfirmed",
  price_objection: "Price objection",
  inactive_high_value: "Quiet big buyer",
};

/**
 * Overview recovery card: money left on the table (abandoned checkouts,
 * unconfirmed COD, price objections, quiet big buyers) with one-tap
 * follow-up (fixed Roman-Urdu copy, never an LLM) and an auto mode.
 */
export default function RecoveryCard() {
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [auto, setAuto] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/recovery", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          items?: RecoveryItem[];
          settings?: { auto_enabled?: boolean };
        };
        setItems(payload.items ?? []);
        setAuto(payload.settings?.auto_enabled ?? false);
        setLoaded(true);
      }
    } catch {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: number, action: "followup" | "dismiss") {
    setBusyId(id);
    try {
      const response = await fetch(
        "/api/omniflow/portal/recovery/" + action,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      );
      if (response.ok) await load();
    } catch {
      /* keep the last known state */
    } finally {
      setBusyId(0);
    }
  }

  async function toggleAuto() {
    const next = !auto;
    setAuto(next);
    try {
      await fetch("/api/omniflow/portal/recovery/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auto_enabled: next,
          checkout_hours: 24,
          cod_hours: 12,
          inactive_days: 21,
          min_value: 5000,
        }),
      });
    } catch {
      setAuto(!next);
    }
  }

  const open = items.filter((item) => item.status === "open");

  return (
    <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-white">
            Revenue recovery
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Abandoned checkouts, unconfirmed COD, price objections and
            quiet big buyers - one follow-up each, fixed polite copy.
          </p>
        </div>
        <button
          onClick={() => void toggleAuto()}
          className={
            "rounded-full border px-3 py-1 text-[11px] transition-colors " +
            (auto
              ? "border-emerald-400/40 bg-emerald-400/[0.12] text-emerald-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:bg-white/[0.05]")
          }
        >
          Auto: {auto ? "on" : "off"}
        </button>
      </div>

      {loaded ? (
        open.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {open.slice(0, 5).map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs text-slate-200">
                    {KIND_LABEL[item.kind] ?? item.kind}
                    <span className="ml-2 text-[10px] text-slate-600">
                      {item.contact_id}
                    </span>
                  </p>
                  <p className="truncate text-[10px] text-slate-500">
                    {item.note}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 text-[11px]">
                  <button
                    onClick={() => void act(item.id, "followup")}
                    disabled={busyId === item.id}
                    className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-1 text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
                  >
                    Follow up
                  </button>
                  <button
                    onClick={() => void act(item.id, "dismiss")}
                    disabled={busyId === item.id}
                    className="text-slate-500 hover:underline disabled:opacity-40"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-slate-500">
            Sab clear - koi recovery pending nahi.
          </p>
        )
      ) : (
        <p className="mt-3 text-xs text-slate-500">Loading&#8230;</p>
      )}
    </section>
  );
}
