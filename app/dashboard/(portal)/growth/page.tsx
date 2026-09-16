"use client";

import { useCallback, useEffect, useState } from "react";

import OrderUpdatesSettings from "./OrderUpdatesSettings";

interface ChurnContact {
  contactId: string;
  name: string;
  chats: number;
  lastAt: string | null;
}

interface StaffingForecast {
  hours: { hour: number; chats: number }[];
  peakHour: number | null;
  peakChats: number;
  suggested: number[];
}

interface BroadcastSuggestion {
  audience: string;
  count: number;
  note: string;
}

interface NegotiationSettings {
  enabled: boolean;
  floorPercent: number;
  maxPercent: number;
}

interface NegotiationQuote {
  ask: number;
  price: number;
  discountPercent: number;
  verdict: string;
  counter: number;
  maxPercent: number;
  enabled: boolean;
}

interface CheckoutLink {
  id: number;
  token: string;
  contactId: string;
  title: string;
  total: number;
  status: string;
}

interface ListenRule {
  id: number;
  keyword: string;
  note: string;
}

interface ListenHit {
  id: number;
  keyword: string;
  contactId: string;
  snippet: string;
}

interface RoutingRule {
  id: number;
  match: string;
  userId: number;
  priority: number;
}

interface ChurnRadarContact {
  contactId: string;
  name: string;
  score: number;
  tier: string;
  reasons: string[];
}

interface RevenueSummaryData {
  days: number;
  revenue: number;
  revenuePrior: number;
  deltaPercent: number | null;
  orders: number;
  ordersPrior: number;
  aov: number | null;
  newBuyers: number;
  repeatBuyers: number;
  cancelled: number;
  cancelledRate: number | null;
  openCarts: number;
  pipelineValue: number;
  winbackSent: number;
}

interface RevenueItemData {
  name: string;
  units: number;
  revenue: number;
  buyers: number;
  unitsPrior: number;
  trend: string;
}

interface RestockItemData {
  name: string;
  weeklyRate: number;
  revenue: number;
  buyers: number;
  lastSoldDays: number | null;
  recentUnits: number;
  priorUnits: number;
  sharePercent: number | null;
  trend: string;
}

interface RestockRadarData {
  stockUp: RestockItemData[];
  watch: RestockItemData[];
  slow: RestockItemData[];
  counts: Record<string, number>;
  itemsSold: number;
  days: number;
}

const DAYS_OPTIONS = [7, 14, 30, 60];

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <p className="text-xs font-semibold text-white">{title}</p>
      <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function GrowthPage() {
  const [churn, setChurn] = useState<ChurnContact[]>([]);
  const [radar, setRadar] = useState<ChurnRadarContact[]>([]);
  const [revenue, setRevenue] = useState<RevenueSummaryData | null>(null);
  const [revItems, setRevItems] = useState<RevenueItemData[]>([]);
  const [restock, setRestock] = useState<RestockRadarData | null>(null);
  const [days, setDays] = useState(14);
  const [staffing, setStaffing] = useState<StaffingForecast | null>(null);
  const [suggestions, setSuggestions] = useState<BroadcastSuggestion[]>([]);
  const [settings, setSettings] = useState<NegotiationSettings | null>(null);
  const [quote, setQuote] = useState<NegotiationQuote | null>(null);
  const [ask, setAsk] = useState("");
  const [price, setPrice] = useState("");
  const [links, setLinks] = useState<CheckoutLink[]>([]);
  const [rules, setRules] = useState<ListenRule[]>([]);
  const [hits, setHits] = useState<ListenHit[]>([]);
  const [keyword, setKeyword] = useState("");
  const [routing, setRouting] = useState<RoutingRule[]>([]);
  const [match, setMatch] = useState("");
  const [userId, setUserId] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [churnPayload, radarPayload, revenuePayload, itemsPayload, forecast, ideas, negotiation, checkout, listenRules, listenHits, routingRules, restockPayload] =
      await Promise.all([
        getJson<{ contacts: ChurnContact[] }>(
          "/api/omniflow/portal/insights/churn?days=" + days
        ),
        getJson<{ contacts: ChurnRadarContact[] }>(
          "/api/omniflow/portal/churn/radar?limit=5"
        ),
        getJson<RevenueSummaryData>(
          "/api/omniflow/portal/revenue/summary?days=" + days
        ),
        getJson<{ items: RevenueItemData[] }>(
          "/api/omniflow/portal/revenue/items?days=" + days
        ),
        getJson<StaffingForecast>("/api/omniflow/portal/insights/staffing"),
        getJson<{ suggestions: BroadcastSuggestion[] }>(
          "/api/omniflow/portal/insights/broadcast-suggestions"
        ),
        getJson<{ settings: NegotiationSettings }>(
          "/api/omniflow/portal/negotiation/settings"
        ),
        getJson<{ links: CheckoutLink[] }>(
          "/api/omniflow/portal/checkout/links"
        ),
        getJson<{ rules: ListenRule[] }>("/api/omniflow/portal/listen/rules"),
        getJson<{ hits: ListenHit[] }>("/api/omniflow/portal/listen/hits"),
        getJson<{ rules: RoutingRule[] }>("/api/omniflow/portal/routing/rules"),
        getJson<RestockRadarData>(
          "/api/omniflow/portal/restock/radar?days=" + days
        ),
      ]);
    setFailed(negotiation === null && forecast === null);
    setChurn(churnPayload?.contacts ?? []);
    setRadar(radarPayload?.contacts ?? []);
    setRevenue(revenuePayload);
    setRevItems(itemsPayload?.items ?? []);
    setStaffing(forecast);
    setSuggestions(ideas?.suggestions ?? []);
    setSettings(negotiation?.settings ?? null);
    setLinks(checkout?.links ?? []);
    setRules(listenRules?.rules ?? []);
    setHits(listenHits?.hits ?? []);
    setRouting(routingRules?.rules ?? []);
    setRestock(restockPayload);
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveLimits(enabled: boolean) {
    if (!settings) return;
    const payload = await getJson<{ settings: NegotiationSettings }>(
      "/api/omniflow/portal/negotiation/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          floor_percent: settings.floorPercent,
          max_percent: settings.maxPercent,
        }),
      }
    );
    if (payload?.settings) setSettings(payload.settings);
  }

  async function runQuote() {
    const askNumber = Number(ask);
    const priceNumber = Number(price);
    if (!Number.isFinite(askNumber) || !Number.isFinite(priceNumber)) return;
    const result = await getJson<NegotiationQuote>(
      "/api/omniflow/portal/negotiation/quote?ask=" + askNumber + "&price=" + priceNumber
    );
    if (result) setQuote(result);
  }

  async function markLink(link: CheckoutLink, status: string) {
    await getJson("/api/omniflow/portal/checkout/links/" + link.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await load();
  }

  async function addKeyword() {
    if (!keyword.trim()) return;
    await getJson("/api/omniflow/portal/listen/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: keyword.trim(), note: "" }),
    });
    setKeyword("");
    await load();
  }

  async function addRoute() {
    if (!match.trim()) return;
    const parsed = Number.parseInt(userId, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    await getJson("/api/omniflow/portal/routing/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match: match.trim(), user_id: parsed, priority: 100 }),
    });
    setMatch("");
    setUserId("");
    await load();
  }

  const peak = staffing?.peakChats ?? 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Growth
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Churn risk, staffing peaks, broadcast ideas, negotiation limits,
          checkout links, keyword alerts and routing rules - all deterministic.
        </p>
      </div>

      {failed ? (
        <p className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-300">
          Some insights are temporarily unavailable. Try again shortly.
        </p>
      ) : null}

      <div className="space-y-4">
        <Section
          title="Revenue & pipeline"
          hint="Paid revenue, buyers and open-cart value for the selected window."
        >
          <div className="mb-3 flex items-center gap-2">
            {DAYS_OPTIONS.map((option) => (
              <button
                key={option}
                onClick={() => setDays(option)}
                className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                  days === option
                    ? "border-cyan-400/30 bg-cyan-400/[0.1] text-cyan-300"
                    : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:bg-white/[0.05]"
                }`}
              >
                {option}d
              </button>
            ))}
          </div>
          {revenue ? (
            <>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2">
                  <p className="text-[10px] text-slate-500">Revenue</p>
                  <p className="mt-0.5 text-lg font-semibold text-white">
                    Rs {revenue.revenue.toLocaleString()}
                  </p>
                  {revenue.deltaPercent === null ? (
                    <p className="text-[10px] text-slate-500">
                      no prior window
                    </p>
                  ) : (
                    <p
                      className={`text-[10px] ${
                        revenue.deltaPercent >= 0
                          ? "text-emerald-300"
                          : "text-rose-300"
                      }`}
                    >
                      {revenue.deltaPercent >= 0 ? "+" : ""}
                      {revenue.deltaPercent}% vs prior
                    </p>
                  )}
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2">
                  <p className="text-[10px] text-slate-500">Orders</p>
                  <p className="mt-0.5 text-lg font-semibold text-white">
                    {revenue.orders}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    AOV Rs {revenue.aov !== null ? revenue.aov.toLocaleString() : "-"}
                    {revenue.cancelled > 0
                      ? " · " + revenue.cancelled + " cancelled"
                      : ""}
                  </p>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2">
                  <p className="text-[10px] text-slate-500">Buyers</p>
                  <p className="mt-0.5 text-lg font-semibold text-white">
                    {revenue.newBuyers + revenue.repeatBuyers}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {revenue.newBuyers} new · {revenue.repeatBuyers} repeat
                  </p>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2">
                  <p className="text-[10px] text-slate-500">Pipeline</p>
                  <p className="mt-0.5 text-lg font-semibold text-white">
                    Rs {revenue.pipelineValue.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {revenue.openCarts} open carts ·{" "}
                    {revenue.winbackSent} win-backs sent
                  </p>
                </div>
              </div>
              {revItems.length > 0 ? (
                <div className="mt-3">
                  <p className="text-[10px] font-semibold text-slate-400">
                    Top items by revenue
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {revItems.slice(0, 5).map((item) => (
                      <li
                        key={item.name}
                        className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5"
                      >
                        <p className="truncate text-xs text-slate-200">
                          {item.name}
                        </p>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-[10px] text-slate-500">
                            {item.units} sold
                            {item.buyers > 0
                              ? " · " + item.buyers + " buyers"
                              : ""}
                          </span>
                          <span
                            className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
                              item.trend === "up"
                                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                                : item.trend === "down"
                                  ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                                  : "border-white/[0.08] bg-white/[0.02] text-slate-400"
                            }`}
                          >
                            {item.trend}
                          </span>
                          <span className="text-[10px] text-slate-300">
                            Rs {item.revenue.toLocaleString()}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-slate-500">
              Revenue data unavailable.
            </p>
          )}
        </Section>

        <Section
          title="Restock radar"
          hint="What to reorder from your sell-through - fast movers, risers and slow items."
        >
          {restock && restock.itemsSold > 0 ? (
            <div className="grid gap-3 md:grid-cols-3">
              {(
                [
                  ["Stock up", restock.stockUp, "text-emerald-300"],
                  ["Watch", restock.watch, "text-amber-300"],
                  ["Slow movers", restock.slow, "text-slate-400"],
                ] as const
              ).map(([label, list, tone]) => (
                <div
                  key={label}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-2.5"
                >
                  <p className={`text-[10px] font-semibold ${tone}`}>
                    {label} ({list.length})
                  </p>
                  {list.length === 0 ? (
                    <p className="mt-1.5 text-[11px] text-slate-600">
                      Nothing here.
                    </p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {list.slice(0, 4).map((item) => (
                        <li
                          key={label + item.name}
                          className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-2 py-1.5"
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <p className="truncate text-xs text-slate-200">
                              {item.name}
                            </p>
                            <span className="shrink-0 text-[10px] text-slate-500">
                              {item.weeklyRate}/wk
                            </span>
                          </div>
                          <p className="mt-0.5 text-[10px] text-slate-600">
                            {item.trend}
                            {item.sharePercent !== null
                              ? " · " + item.sharePercent + "% of revenue"
                              : ""}
                            {item.lastSoldDays !== null
                              ? " · last sold " + item.lastSoldDays + "d ago"
                              : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Sell a few orders to see restock signals.
            </p>
          )}
        </Section>

        <Section
          title="Churn radar"
          hint="Scored from quiet chats, unanswered replies, cold carts and slowing orders."
        >
          {radar.length === 0 ? (
            <p className="text-xs text-slate-500">
              No churn signals right now.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {radar.map((entry) => (
                <li
                  key={entry.contactId}
                  className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">
                      {entry.name || entry.contactId}
                    </p>
                    {entry.reasons[0] ? (
                      <p className="truncate text-[10px] text-slate-500">
                        {entry.reasons[0]}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${
                      entry.tier === "at_risk"
                        ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                        : "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
                    }`}
                  >
                    {entry.score} ·{" "}
                    {entry.tier === "at_risk" ? "at risk" : "cooling"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Churn risk"
          hint="Customers with no activity for the selected window."
        >
          {churn.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              No quiet customers in this window.
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {churn.slice(0, 10).map((contact) => (
                <li
                  key={contact.contactId}
                  className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">
                      {contact.name || contact.contactId}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {contact.contactId} · {contact.chats} chats
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] text-slate-500">
                    {contact.lastAt ? "last: " + contact.lastAt : "unknown"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Staffing peaks"
          hint="Inbound chats by hour (last 28 days) and when to have people online."
        >
          {staffing && peak > 0 ? (
            <>
              <div className="flex h-24 items-end gap-1">
                {staffing.hours.map((entry) => (
                  <div
                    key={entry.hour}
                    title={entry.hour + ":00 - " + entry.chats + " chats"}
                    className={`flex-1 rounded-t ${
                      staffing.suggested.includes(entry.hour)
                        ? "bg-cyan-400/60"
                        : "bg-white/[0.08]"
                    }`}
                    style={{
                      height: Math.max(4, (entry.chats / peak) * 96) + "px",
                    }}
                  />
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Peak at {staffing.peakHour}:00 ({staffing.peakChats} chats).
                Suggested coverage:{" "}
                {staffing.suggested.map((hour) => hour + ":00").join(", ") ||
                  "even all day"}
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-500">Not enough data yet.</p>
          )}
        </Section>

        <Section
          title="Broadcast ideas"
          hint="Audiences built from your existing workspace data."
        >
          <ul className="space-y-1.5">
            {suggestions.map((idea) => (
              <li
                key={idea.audience}
                className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
              >
                <p className="text-sm text-slate-200">
                  {idea.audience} · {idea.count} contacts
                </p>
                <p className="text-[11px] text-slate-500">{idea.note}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Negotiation limits"
          hint="Set your discount ceiling; the calculator suggests counters instantly."
        >
          {settings ? (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span>Max discount: {settings.maxPercent}%</span>
                <button
                  onClick={() => void saveLimits(!settings.enabled)}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    settings.enabled
                      ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                      : "border-white/[0.08] bg-white/[0.02] text-slate-400"
                  }`}
                >
                  {settings.enabled ? "Guardrails ON" : "Guardrails OFF"}
                </button>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  value={ask}
                  onChange={(event) => setAsk(event.target.value)}
                  placeholder="Customer asks (e.g. 1500)"
                  className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-cyan-400/40"
                />
                <input
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  placeholder="Your price (e.g. 2000)"
                  className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-cyan-400/40"
                />
                <button
                  onClick={() => void runQuote()}
                  className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-sm font-medium text-cyan-300 transition-colors hover:bg-cyan-400/[0.14]"
                >
                  Calculate
                </button>
              </div>
              {quote ? (
                <p className="mt-2 text-xs text-slate-400">
                  Ask {quote.ask} vs price {quote.price} ({quote.discountPercent}
                  % off) →{" "}
                  {quote.verdict === "accept" ? (
                    <span className="text-emerald-300">
                      accept {quote.counter}
                    </span>
                  ) : (
                    <span className="text-amber-300">
                      counter at {quote.counter} (max {quote.maxPercent}%)
                    </span>
                  )}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-slate-500">Settings unavailable.</p>
          )}
        </Section>

        <Section
          title="Checkout links"
          hint="Shareable order summaries - the customer opens the link, you close the deal in chat."
        >
          {links.length === 0 ? (
            <p className="text-xs text-slate-500">
              No checkout links yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {links.slice(0, 8).map((link) => (
                <li
                  key={link.id}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-200">
                        {link.title || link.contactId} · {link.total}
                      </p>
                      <p className="truncate text-[10px] text-slate-500">
                        /c/{link.token}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span
                        className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
                          link.status === "paid"
                            ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                            : link.status === "cancelled"
                              ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                              : link.status === "shipped"
                                ? "border-sky-400/25 bg-sky-400/[0.08] text-sky-300"
                                : link.status === "delivered"
                                  ? "border-violet-400/25 bg-violet-400/[0.08] text-violet-300"
                                  : "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
                        }`}
                      >
                        {link.status}
                      </span>
                      {link.status === "open" ? (
                        <>
                          <button
                            onClick={() => void markLink(link, "paid")}
                            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                          >
                            Paid
                          </button>
                          <button
                            onClick={() => void markLink(link, "cancelled")}
                            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                          >
                            Cancel
                          </button>
                        </>
                      ) : null}
                      {link.status === "paid" ? (
                        <button
                          onClick={() => void markLink(link, "shipped")}
                          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                        >
                          Shipped
                        </button>
                      ) : null}
                      {link.status === "shipped" ? (
                        <button
                          onClick={() => void markLink(link, "delivered")}
                          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                        >
                          Delivered
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <OrderUpdatesSettings />

        <Section
          title="Keyword alerts"
          hint="Get a hit whenever an inbound message contains one of your keywords."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="e.g. franchise, bulk order, complaint"
              className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-cyan-400/40"
            />
            <button
              onClick={() => void addKeyword()}
              disabled={!keyword.trim()}
              className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-sm font-medium text-cyan-300 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50"
            >
              Watch
            </button>
          </div>
          {rules.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {rules.map((rule) => (
                <span
                  key={rule.id}
                  className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.08] px-1.5 py-0.5 text-[10px] text-cyan-300"
                >
                  {rule.keyword}
                </span>
              ))}
            </div>
          ) : null}
          {hits.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {hits.slice(0, 5).map((hit) => (
                <li key={hit.id} className="text-[11px] text-slate-500">
                  <span className="text-cyan-300">{hit.keyword}</span> ·{" "}
                  {hit.contactId} · “{hit.snippet}”
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section
          title="Routing rules"
          hint="Assign chats to teammates automatically when a keyword matches."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={match}
              onChange={(event) => setMatch(event.target.value)}
              placeholder="If message contains…"
              className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-cyan-400/40"
            />
            <input
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="Team user id"
              className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-cyan-400/40 sm:w-36"
            />
            <button
              onClick={() => void addRoute()}
              disabled={!match.trim()}
              className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-sm font-medium text-cyan-300 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50"
            >
              Add rule
            </button>
          </div>
          {routing.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {routing.map((rule) => (
                <li key={rule.id} className="text-[11px] text-slate-500">
                  “{rule.match}” → user {rule.userId} (priority {rule.priority})
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      </div>
    </div>
  );
}
