"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { LoyaltyCustomer } from "../../../../../lib/omniflow/portal";

const HELD: Record<string, string> = {
  opted_out: "opted out",
  open_cart: "has an open cart",
  in_sequence: "in a sequence",
  cooldown: "contacted recently",
};

function money(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** §238 loyalty line: tier, purchases, progress to the next tier, due message. */
export default function LoyaltyCard({ contactId }: { contactId: string | null }) {
  const [view, setView] = useState<LoyaltyCustomer | null>(null);

  useEffect(() => {
    if (!contactId) return;
    let live = true;
    fetch("/api/omniflow/portal/retention/customer?contact_id=" + encodeURIComponent(contactId), {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((response) => (response.ok ? (response.json() as Promise<LoyaltyCustomer>) : null))
      .then((data) => {
        if (live) setView(data);
      })
      .catch(() => {
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, [contactId]);

  if (!view || view.orders === 0) return null;
  const details = [
    view.orders === 1 ? "1 order" : view.orders + " orders",
    money(view.spend) + " spent",
    view.favourite ? "favourite: " + view.favourite : "",
    view.lastOrderDays === null ? "" : "last order " + view.lastOrderDays + "d ago",
  ].filter(Boolean);

  return (
    <section className="mb-4 rounded-2xl border border-line bg-white shadow-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-ink">Loyalty</h2>
          <p className="mt-0.5 text-xs text-ink-2">
            <span className="text-brand">{view.tier ? view.tier.label : "No tier yet"}</span>
            {" \u00b7 " + details.join(" \u00b7 ")}
          </p>
        </div>
        <Link href="/dashboard/retention" className="text-[11px] text-ink-3 hover:text-ink">
          Retention
        </Link>
      </div>
      {view.next ? (
        <p className="mt-2 text-[11px] text-ink-3">
          {"Next: " + view.next.label + " - "}
          {[
            view.next.ordersNeeded ? view.next.ordersNeeded + " more order" + (view.next.ordersNeeded === 1 ? "" : "s") : "",
            view.next.spendNeeded ? money(view.next.spendNeeded) + " more spend" : "",
          ]
            .filter(Boolean)
            .join(" and ")}
        </p>
      ) : null}
      {view.optedOut ? <p className="mt-2 text-[11px] text-amber-600">Opted out of messages.</p> : null}
      {view.due && !view.optedOut ? (
        <div className="mt-2 rounded-lg bg-soft px-2.5 py-1.5 text-[11px]">
          <p className="text-ink-2">
            {(view.due.kind === "reorder" ? "Reorder due" : "Win-back due") +
              (view.due.held ? " \u00b7 held: " + (HELD[view.due.held] || view.due.held) : "")}
          </p>
          <p className="mt-0.5 text-ink-3">{view.due.message}</p>
        </div>
      ) : null}
    </section>
  );
}
