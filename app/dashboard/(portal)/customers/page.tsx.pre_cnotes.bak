"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

interface CustomerSummary {
  contactId: string;
  name: string;
  channels: string[];
  conversationCount: number;
  openCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  leadTemp: string;
  tags: string[];
}

const POLL_MS = 30_000;

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 360;
  }
  return hash;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const debounceRef = useRef<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<
    "all" | "whatsapp" | "website"
  >("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchRef.current) params.set("q", searchRef.current);
      if (channelRef.current !== "all") {
        params.set("channel", channelRef.current);
      }
      const qs = params.toString();
      const response = await fetch(
        "/api/omniflow/portal/customers" + (qs ? "?" + qs : ""),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        customers?: CustomerSummary[];
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.customers)) {
        setCustomers(payload.customers);
        setPending(false);
      } else if (payload.error?.code === "portal_pending") {
        setPending(true);
        setCustomers([]);
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      searchRef.current = value.trim();
      void refresh();
    }, 300);
  }

  if (expired) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
        <p className="text-sm text-slate-300">Session expired.</p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-white">Customers</h1>
      <p className="mt-0.5 text-xs text-slate-500">
        Every contact across WhatsApp and the website — search, filter, and
        jump straight into their chats.
      </p>

      <div className="mt-4">
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by name or contact…"
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
      </div>

      <div className="mb-4 mt-3 flex flex-wrap items-center gap-2">
        {(["all", "whatsapp", "website"] as const).map((value) => (
          <button
            key={value}
            onClick={() => {
              channelRef.current = value;
              setChannelFilter(value);
              void refresh();
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              channelFilter === value
                ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
            }`}
          >
            {value === "all" ? "All channels" : value}
          </button>
        ))}
      </div>

      {!customers ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-20 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">
            {pending
              ? "Connecting to the inbox — customers appear in a minute."
              : search
                ? "No customers match that search."
                : "No customers yet — they appear with the first message."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {customers.map((customer) => (
            <li key={customer.contactId}>
              <Link
                href={
                  "/dashboard/conversations?q=" +
                  encodeURIComponent(customer.contactId)
                }
                className="block rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-white/[0.12] hover:bg-white/[0.03]"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] text-sm font-semibold text-cyan-200">
                      {(customer.name || customer.contactId || "?")
                        .trim()
                        .charAt(0)
                        .toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {customer.name || customer.contactId}
                      </p>
                      {customer.name && (
                        <p className="truncate text-[11px] text-slate-500">
                          {customer.contactId}
                        </p>
                      )}
                      {customer.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {customer.tags.slice(0, 3).map((tag) => (
                            <span
                              key={"cust-tag-" + tag}
                              className="inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-medium tracking-wide"
                              style={{
                                borderColor:
                                  `hsl(${tagHue(tag)} 70% 50% / 0.3)`,
                                backgroundColor:
                                  `hsl(${tagHue(tag)} 70% 50% / 0.10)`,
                                color: `hsl(${tagHue(tag)} 80% 72%)`,
                              }}
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 sm:text-right">
                    <p className="text-[11px] text-slate-400">
                      {customer.conversationCount}{" "}
                      {customer.conversationCount === 1 ? "chat" : "chats"}
                      {customer.openCount > 0 &&
                        " · " + customer.openCount + " open"}
                      {" · "}
                      {customer.channels.join(", ")}
                    </p>
                    {customer.lastMessagePreview && (
                      <p className="mt-0.5 max-w-xs truncate text-xs text-slate-300 sm:ml-auto">
                        {customer.lastMessagePreview}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] text-slate-600">
                      {formatWhen(customer.lastMessageAt)}
                    </p>
                  </div>
                </div>
                {customer.leadTemp !== "cold" && (
                  <div className="mt-2 flex">
                    <span
                      className={
                        "inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                        (customer.leadTemp === "hot"
                          ? "border-orange-400/25 bg-orange-400/[0.08] text-orange-300"
                          : "border-amber-400/20 bg-amber-400/[0.05] text-amber-200/80")
                      }
                    >
                      {customer.leadTemp} lead
                    </span>
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
