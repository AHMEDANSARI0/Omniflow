"use client";

import Link from "next/link";
import CustomerMemoryCard from "./CustomerMemoryCard";
import CustomerJourneyCard from "./CustomerJourneyCard";
import { useCallback, useEffect, useState } from "react";

interface CustomerValueData {
  totalSpent: number;
  orders: number;
  units: number;
  avgOrder: number | null;
  topItem: string;
  medianGapDays: number | null;
  lastOrderDays: number | null;
  tier: string;
}

interface RecoSuggestion {
  name: string;
  priceText: string;
  reasons: string[];
}


interface ProfileAction {
  id: number;
  kind: string;
  status: string;
  note: string;
  createdAt: string | null;
}

interface Profile {
  contactId: string;
  name: string;
  leadTemp: string;
  language: string | null;
  linkedChannels: string[];
  actions: ProfileAction[];
  chats: number;
  openChats: number;
  firstSeen: string | null;
  lastSeen: string | null;
  tags: string[];
  conversations: {
    id: number;
    status: string;
    channel: string;
    lastMessageAt: string | null;
  }[];
  codRequests: {
    id: number;
    status: string;
    createdAt: string | null;
    answeredAt: string | null;
  }[];
  sequences: {
    name: string;
    status: string;
    currentStep: number;
    enrolledAt: string | null;
  }[];
  notes: { body: string; authorEmail: string; createdAt: string | null }[];
}

function when(value: string | null): string {
  if (!value) return "\\u2014";
  const stamp = Date.parse(value);
  if (Number.isNaN(stamp)) return "\\u2014";
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  return Math.floor(days / 30) + "mo ago";
}

const LEAD_STYLES: Record<string, string> = {
  hot: "border-orange-400/25 bg-orange-400/[0.08] text-orange-300",
  warm: "border-amber-400/20 bg-amber-400/[0.05] text-amber-200/80",
  cold: "border-white/[0.08] bg-white/[0.02] text-slate-400",
};

const COD_STYLES: Record<string, string> = {
  confirmed: "text-emerald-300",
  declined: "text-rose-300",
  pending: "text-amber-300",
};

export default function ProfileClient({ contact }: { contact: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [missing, setMissing] = useState(false);
  const [risk, setRisk] = useState<string | null>(null);
  const [recos, setRecos] = useState<RecoSuggestion[]>([]);
  const [churn, setChurn] = useState<{ score: number; tier: string; reason: string } | null>(null);
  const [value, setValue] = useState<CustomerValueData | null>(null);

  const load = useCallback(async () => {
    if (!contact) {
      setMissing(true);
      return;
    }
    try {
      const response = await fetch(
        "/api/omniflow/portal/customers/profile?contact=" +
          encodeURIComponent(contact),
        { cache: "no-store" }
      );
      if (!response.ok) {
        setMissing(true);
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        setProfile(payload as unknown as Profile);
      } else {
        setMissing(true);
      }
    } catch {
      setMissing(true);
    }
  }, [contact]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!profile?.contactId) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          "/api/omniflow/portal/fraud/score?contact=" +
            encodeURIComponent(profile.contactId),
          { cache: "no-store" }
        );
        if (!response.ok) {
          if (active) setRisk(null);
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (active && payload !== null && typeof payload === "object") {
          const level = (payload as Record<string, unknown>).level;
          const score = (payload as Record<string, unknown>).score;
          if (level === "watch" || level === "high") {
            setRisk(level);
          } else if (typeof score === "number" && score > 0) {
            setRisk("low");
          } else {
            setRisk(null);
          }
        } else if (active) {
          setRisk(null);
        }
      } catch {
        if (active) setRisk(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [profile?.contactId]);

  useEffect(() => {
    if (!profile?.contactId) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          "/api/omniflow/portal/reco/suggest?contact=" +
            encodeURIComponent(profile.contactId),
          { cache: "no-store" }
        );
        if (!response.ok) {
          if (active) setRecos([]);
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (active && payload !== null && typeof payload === "object") {
          const raw = (payload as Record<string, unknown>).suggestions;
          if (Array.isArray(raw)) {
            setRecos(
              raw
                .filter((item): item is Record<string, unknown> =>
                  item !== null && typeof item === "object")
                .map((item) => ({
                  name: typeof item.name === "string" ? item.name : "",
                  priceText:
                    typeof item.price_text === "string" ? item.price_text : "",
                  reasons: Array.isArray(item.reasons)
                    ? item.reasons.filter(
                        (reason): reason is string => typeof reason === "string"
                      )
                    : [],
                }))
                .filter((item) => item.name)
            );
          } else if (active) {
            setRecos([]);
          }
        }
      } catch {
        if (active) setRecos([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [profile?.contactId]);

  useEffect(() => {
    if (!profile?.contactId) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          "/api/omniflow/portal/churn/score?contact=" +
            encodeURIComponent(profile.contactId),
          { cache: "no-store" }
        );
        if (!response.ok) {
          if (active) setChurn(null);
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (active && payload !== null && typeof payload === "object") {
          const raw = payload as Record<string, unknown>;
          const score = typeof raw.score === "number" ? raw.score : 0;
          const tier = typeof raw.tier === "string" ? raw.tier : "";
          const reasons = Array.isArray(raw.reasons)
            ? raw.reasons.filter((reason): reason is string =>
                typeof reason === "string"
              )
            : [];
          if (score > 0 && (tier === "cooling" || tier === "at_risk")) {
            setChurn({ score, tier, reason: reasons[0] ?? "" });
          } else if (active) {
            setChurn(null);
          }
        } else if (active) {
          setChurn(null);
        }
      } catch {
        if (active) setChurn(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [profile?.contactId]);

  useEffect(() => {
    if (!profile?.contactId) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          "/api/omniflow/portal/value/summary?contact=" +
            encodeURIComponent(profile.contactId),
          { cache: "no-store" }
        );
        if (!response.ok) {
          if (active) setValue(null);
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (active && payload !== null && typeof payload === "object") {
          const raw = payload as Record<string, unknown>;
          const num = (key: string): number =>
            typeof raw[key] === "number" ? (raw[key] as number) : 0;
          const opt = (key: string): number | null =>
            typeof raw[key] === "number" ? (raw[key] as number) : null;
          setValue({
            totalSpent: num("total_spent"),
            orders: num("orders"),
            units: num("units"),
            avgOrder: opt("avg_order"),
            topItem: typeof raw.top_item === "string" ? raw.top_item : "",
            medianGapDays: opt("median_gap_days"),
            lastOrderDays: opt("last_order_days"),
            tier: typeof raw.tier === "string" ? raw.tier : "new",
          });
        } else if (active) {
          setValue(null);
        }
      } catch {
        if (active) setValue(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [profile?.contactId]);

  if (missing || !contact) {
    return (
      <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm text-slate-400">
            No customer selected.{" "}
            <Link
              href="/dashboard/customers"
              className="text-cyan-300 transition hover:text-cyan-200"
            >
              Pick one from Customers
            </Link>
            .
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard/customers"
          className="text-xs text-slate-500 transition hover:text-white"
        >
          \\u2190 Customers
        </Link>
        <div className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-white">
                {profile ? profile.name || "Customer" : "Loading\\u2026"}
              </h1>
              <p className="mt-0.5 break-all font-mono text-[11px] text-slate-500">
                {contact}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {profile ? (
                <span
                  className={
                    "rounded-md border px-1.5 py-0.5 text-[10px] " +
                    (LEAD_STYLES[profile.leadTemp] ?? LEAD_STYLES.cold)
                  }
                >
                  {profile.leadTemp} lead
                </span>
              ) : null}
              <a
                href={`https://wa.me/${contact.replace(/[^0-9]/g, "")}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-emerald-300 transition hover:text-emerald-200"
              >
                WhatsApp
              </a>
            </div>
          </div>
          {profile ? (
            <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-2">
                <p className="text-lg font-semibold text-white">{profile.chats}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">
                  Total chats
                </p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-2">
                <p className="text-lg font-semibold text-white">
                  {profile.openChats}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">
                  Open now
                </p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-2">
                <p className="truncate text-sm font-medium text-slate-300">
                  {when(profile.firstSeen)}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">
                  First seen
                </p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-2">
                <p className="truncate text-sm font-medium text-slate-300">
                  {when(profile.lastSeen)}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">
                  Last seen
                </p>
              </div>
            </div>
          ) : null}
          {profile && (profile.language || profile.linkedChannels.length > 0) ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
              {profile.language ? (
                <span className="rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-violet-300">
                  Language: {profile.language}
                </span>
              ) : null}
              {profile.linkedChannels.map((linked) => (
                <span
                  key={linked}
                  className="rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-slate-400"
                >
                  Linked: {linked}
                </span>
              ))}
              {risk ? (
                <span
                  className={`rounded-md border px-1.5 py-0.5 ${
                    risk === "high"
                      ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                      : "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
                  }`}
                >
                  Risk: {risk}
                </span>
              ) : null}
              {churn ? (
                <span
                  title={churn.reason}
                  className={`rounded-md border px-1.5 py-0.5 ${
                    churn.tier === "at_risk"
                      ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                      : "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
                  }`}
                >
                  Churn: {churn.tier === "at_risk" ? "at risk" : "cooling"} (
                  {churn.score})
                </span>
              ) : null}
            </div>
          ) : null}
          {profile && profile.tags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {profile.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.08] px-1.5 py-0.5 text-[10px] text-cyan-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {contact ? <CustomerMemoryCard contact={contact} /> : null}
        {contact ? <CustomerJourneyCard contact={contact} /> : null}

        {profile && recos.length > 0 ? (
          <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
            <p className="text-xs font-semibold text-white">
              Recommended next
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Deterministic picks from orders, chat mentions and bestsellers.
            </p>
            <ul className="mt-2 space-y-1.5">
              {recos.slice(0, 3).map((suggestion) => (
                <li
                  key={suggestion.name}
                  className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">
                      {suggestion.name}
                    </p>
                    {suggestion.reasons[0] ? (
                      <p className="truncate text-[10px] text-cyan-300/80">
                        {suggestion.reasons[0]}
                      </p>
                    ) : null}
                  </div>
                  {suggestion.priceText ? (
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {suggestion.priceText}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {profile && value ? (
          <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-white">
                Lifetime value
              </p>
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
                  value.tier === "loyal"
                    ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                    : value.tier === "repeat"
                      ? "border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-300"
                      : value.tier === "lapsed"
                        ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                        : "border-white/[0.08] bg-white/[0.02] text-slate-400"
                }`}
              >
                {value.tier}
              </span>
            </div>
            {value.orders === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No orders yet.</p>
            ) : (
              <>
                <p className="mt-1.5 text-2xl font-semibold text-white">
                  Rs {value.totalSpent.toLocaleString()}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {value.orders} orders · {value.units} items
                  {value.avgOrder !== null
                    ? " · avg Rs " + value.avgOrder.toLocaleString()
                    : ""}
                  {value.topItem
                    ? " · mostly " + value.topItem
                    : ""}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {value.lastOrderDays !== null
                    ? "Last order " + value.lastOrderDays + " days ago"
                    : ""}
                  {value.medianGapDays !== null
                    ? " · reorder gap ~" + value.medianGapDays + " days"
                    : ""}
                </p>
              </>
            )}
          </section>
        ) : null}

        {profile ? (
          <>
            <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
              <p className="text-xs font-semibold text-white">Conversations</p>
              {profile.conversations.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">No chats yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {profile.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        prefetch={false}
                        href={"/dashboard/conversations/" + conversation.id}
                        className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-white/[0.03]"
                      >
                        <span className="text-slate-300">
                          #{conversation.id} \\u00b7 {conversation.channel}
                        </span>
                        <span
                          className={
                            conversation.status === "open"
                              ? "text-emerald-300"
                              : "text-slate-500"
                          }
                        >
                          {conversation.status} \\u00b7{" "}
                          {when(conversation.lastMessageAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
              <p className="text-xs font-semibold text-white">COD orders</p>
              {profile.codRequests.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">No COD asks yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {profile.codRequests.map((order) => (
                    <li
                      key={order.id}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="text-slate-300">Order #{order.id}</span>
                      <span className={COD_STYLES[order.status] ?? "text-slate-500"}>
                        {order.status} \\u00b7 {when(order.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
              <p className="text-xs font-semibold text-white">Series</p>
              {profile.sequences.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  Not enrolled in any series.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {profile.sequences.map((series) => (
                    <li
                      key={series.name}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate text-slate-300">{series.name}</span>
                      <span className="shrink-0 text-slate-500">
                        {series.status} \\u00b7 step {series.currentStep + 1} \\u00b7{" "}
                        {when(series.enrolledAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
              <p className="text-xs font-semibold text-white">Action requests</p>
              {profile.actions.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  No cancel / address / refund requests yet.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {profile.actions.map((action) => (
                    <li
                      key={action.id}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate text-slate-300">
                        {action.kind}
                        {action.note ? " \u00b7 " + action.note : ""}
                      </span>
                      <span
                        className={
                          action.status === "done"
                            ? "shrink-0 text-emerald-300"
                            : action.status === "declined"
                              ? "shrink-0 text-rose-300"
                              : "shrink-0 text-amber-300"
                        }
                      >
                        {action.status} \u00b7 {when(action.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
              <p className="text-xs font-semibold text-white">Notes</p>
              {profile.notes.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">No notes yet.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {profile.notes.map((note, index) => (
                    <li
                      key={index}
                      className="rounded-lg border border-white/[0.05] bg-white/[0.01] p-2.5"
                    >
                      <p className="text-xs text-slate-300">{note.body}</p>
                      <p className="mt-1 text-[10px] text-slate-600">
                        {note.authorEmail} \\u00b7 {when(note.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : (
          <p className="mt-4 text-sm text-slate-500">Loading\\u2026</p>
        )}
      </div>
    </main>
  );
}
