"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface SetupFlags {
  whatsapp: boolean;
  hours: boolean;
  away: boolean;
  kb: boolean;
  customers: boolean;
  broadcast: boolean;
  cod: boolean;
}

const ITEMS: { key: keyof SetupFlags; label: string; hint: string; href: string }[] = [
  {
    key: "whatsapp",
    label: "Connect your WhatsApp number",
    hint: "Scan the QR from the connector laptop",
    href: "/dashboard/channels/whatsapp",
  },
  {
    key: "hours",
    label: "Set your business hours",
    hint: "Powers away replies and the thread banner",
    href: "/dashboard/settings",
  },
  {
    key: "away",
    label: "Turn on away replies",
    hint: "Customers get an instant reply outside hours",
    href: "/dashboard/settings",
  },
  {
    key: "kb",
    label: "Add knowledge base answers",
    hint: "FAQs the assistant can use verbatim",
    href: "/dashboard/knowledge-base",
  },
  {
    key: "customers",
    label: "Bring customers in",
    hint: "Chats, or a CSV import from the Customers page",
    href: "/dashboard/customers",
  },
  {
    key: "broadcast",
    label: "Send your first broadcast",
    hint: "One message to a whole audience",
    href: "/dashboard/broadcasts",
  },
  {
    key: "cod",
    label: "Enable COD confirmations",
    hint: "Cut returns on cash-on-delivery orders",
    href: "/dashboard/cod",
  },
];

export default function SetupChecklist() {
  const [flags, setFlags] = useState<SetupFlags | null>(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/setup", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const setup = (payload as { setup?: SetupFlags }).setup;
        if (setup) setFlags(setup);
      }
    } catch {
      /* the card simply stays hidden on failure */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!flags || hidden) return null;

  const doneCount = ITEMS.filter((item) => flags[item.key]).length;
  const total = ITEMS.length;
  const percent = Math.round((doneCount / total) * 100);

  return (
    <div className="mb-8 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.03] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Setup progress</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {doneCount === total
              ? "All set \u2014 every feature is configured."
              : String(doneCount) + " of " + String(total) + " steps done"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
        >
          Recheck
        </button>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={
            "h-full rounded-full transition-all duration-500 " +
            (doneCount === total ? "bg-emerald-400/70" : "bg-cyan-400/70")
          }
          style={{ width: String(percent) + "%" }}
        />
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {ITEMS.map((item) => {
          const done = flags[item.key];
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                className={
                  "flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors duration-300 " +
                  (done
                    ? "border-emerald-400/15 bg-emerald-400/[0.04]"
                    : "border-white/[0.06] bg-white/[0.01] hover:border-cyan-400/25")
                }
              >
                <span
                  className={
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] " +
                    (done
                      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-300"
                      : "border-white/15 text-slate-600")
                  }
                  aria-hidden
                >
                  {done ? "\u2713" : ""}
                </span>
                <span className="min-w-0">
                  <span
                    className={
                      "block text-sm " + (done ? "text-slate-400 line-through" : "text-slate-200")
                    }
                  >
                    {item.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-600">
                    {item.hint}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
