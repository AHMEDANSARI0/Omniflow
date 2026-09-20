"use client";

import { useCallback, useEffect, useState } from "react";

import OrderUpdatesSettings from "./OrderUpdatesSettings";
import CheckoutReturnsCard from "./CheckoutReturnsCard";
import DigestCard from "./DigestCard";

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

interface CheckoutLinkItem {
  name: string;
  qty: number;
  price: number;
}

interface CustomerAnalyticsRow {
  contact_id: string;
  orders: number;
  spend: number;
  avg_order: number;
  tier: string;
  last_order: string | null;
}

interface ProductAnalyticsRow {
  name: string;
  qty_sold: number;
  revenue: number;
  orders: number;
}


interface ComposerRow {
  name: string;
  qty: string;
  price: string;
}

interface CatalogPick {
  id: number;
  name: string;
  priceText: string;
  isActive: boolean;
}

interface ChangeRequestRow {
  id: number;
  kind: string;
  message: string;
  addressText: string;
  status: string;
  title: string;
  createdAt: string | null;
}

interface CheckoutComposer {
  open: boolean;
  contact: string;
  title: string;
  rows: ComposerRow[];
  discount: string;
  expiry: string;
  busy: boolean;
}

const EMPTY_COMPOSER: CheckoutComposer = {
  open: false,
  contact: "",
  title: "",
  rows: [{ name: "", qty: "1", price: "" }],
  discount: "",
  expiry: "",
  busy: false,
}

interface CheckoutLink {
  id: number;
  token: string;
  contactId: string;
  title: string;
  total: number;
  status: string;
  items: CheckoutLinkItem[];
  expiresAt?: string | null;
  viewCount?: number;
  paidAmount?: number;
  discount?: number;
  courier?: string;
  trackingNumber?: string;
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

const RETURN_REASONS: [string, string][] = [
  ["size", "Size"],
  ["fit", "Fit"],
  ["damaged", "Damaged"],
  ["late", "Late"],
  ["changed_mind", "Changed mind"],
  ["other", "Other"],
];

export default function GrowthPage() {
  const [churn, setChurn] = useState<ChurnContact[]>([]);
  const [radar, setRadar] = useState<ChurnRadarContact[]>([]);
  const [revenue, setRevenue] = useState<RevenueSummaryData | null>(null);
  const [revItems, setRevItems] = useState<RevenueItemData[]>([]);
  const [restock, setRestock] = useState<RestockRadarData | null>(null);
  const [days, setDays] = useState(14);
  const [returnFor, setReturnFor] = useState<number | null>(null);
  const [editFor, setEditFor] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editItems, setEditItems] = useState<
    { name: string; qty: string; price: string }[]
  >([]);
  const [editBusy, setEditBusy] = useState(false);
  const [editExpiry, setEditExpiry] = useState("");
  const [editDiscount, setEditDiscount] = useState("");
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [advanceNote, setAdvanceNote] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [statusNoteFor, setStatusNoteFor] = useState<number | null>(null);
  const [composer, setComposer] = useState<CheckoutComposer>(EMPTY_COMPOSER);
  const [catalogItems, setCatalogItems] = useState<CatalogPick[]>([]);
  const [changeReqs, setChangeReqs] = useState<ChangeRequestRow[]>([]);
  const [reqBusy, setReqBusy] = useState(0);
  const [changeNote, setChangeNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [catalogRes, requestsRes] = await Promise.all([
          fetch("/api/omniflow/portal/catalog", { cache: "no-store" }),
          fetch("/api/omniflow/portal/changes/requests?status=pending", {
            cache: "no-store",
          }),
        ]);
        const catalog = await catalogRes.json().catch(() => null);
        const requests = await requestsRes.json().catch(() => null);
        if (cancelled) return;
        if (catalog && Array.isArray(catalog.items)) {
          setCatalogItems(catalog.items);
        }
        if (requests && Array.isArray(requests.requests)) {
          setChangeReqs(requests.requests);
        }
      } catch {
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [custAnalytics, setCustAnalytics] = useState<
    CustomerAnalyticsRow[]
  >([]);
  const [prodAnalytics, setProdAnalytics] = useState<
    ProductAnalyticsRow[]
  >([]);
  const [trackFor, setTrackFor] = useState<number | null>(null);
  const [trackCourier, setTrackCourier] = useState("");
  const [trackNumber, setTrackNumber] = useState("");
  const [trackBusy, setTrackBusy] = useState(false);

  async function downloadCsv(path: string, filename: string) {
    try {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      return;
    }
  }

  function isExpired(link: CheckoutLink) {
    if (!link.expiresAt || link.status !== "open") return false;
    return new Date(link.expiresAt).getTime() < Date.now();
  }

  function expiryLabel(link: CheckoutLink) {
    if (!link.expiresAt) return null;
    if (isExpired(link)) return "Expired";
    const daysLeft = Math.ceil(
      (new Date(link.expiresAt).getTime() - Date.now()) / 86400000
    );
    return daysLeft <= 1 ? "Ends today" : daysLeft + "d left";
  }

  function dueOf(link: CheckoutLink) {
    return Math.max(
      Math.round(((link.total || 0) - (link.paidAmount || 0)) * 100) / 100,
      0
    );
  }

  async function recordAdvance(link: CheckoutLink) {
    if (advanceBusy) return;
    const amount = Math.round(Number(advanceAmount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return;
    setAdvanceBusy(true);
    setAdvanceNote("");
    try {
      const result = await getJson<
        | { ok: true; paid_amount: number; due: number; status: string }
        | { error: { message: string } }
      >(
        "/api/omniflow/portal/checkout/links/" + link.id + "/advance",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount }),
        }
      );
      if (result === null) {
        setAdvanceNote("Could not record the advance - try again.");
        return;
      }
      if ("error" in result) {
        setAdvanceNote(result.error.message);
        return;
      }
      setAdvanceAmount("");
      await load();
    } catch {
      return;
    } finally {
      setAdvanceBusy(false);
    }
  }

  function updateComposer(patch: Partial<CheckoutComposer>) {
    setComposer((prev) => ({ ...prev, ...patch }));
  }

  function updateRow(index: number, patch: Partial<ComposerRow>) {
    setComposer((prev) => ({
      ...prev,
      rows: prev.rows.map((row, row2) =>
        row2 === index ? { ...row, ...patch } : row
      ),
    }));
  }

  function addCatalogRow(item: CatalogPick) {
    const digits = (item.priceText || "").replace(/[^0-9.]/g, "");
    const parsed = parseFloat(digits);
    const price = Number.isFinite(parsed) && parsed > 0
      ? Math.round(parsed * 100) / 100
      : 0;
    setComposer((prev) => {
      const rows = [...prev.rows];
      const blank = rows.length === 1 && !rows[0].name.trim()
        && !rows[0].price.trim();
      const row = { name: item.name, qty: "1", price: price ? String(price) : "" };
      if (blank) {
        rows[0] = row;
      } else {
        rows.push(row);
      }
      return { ...prev, rows };
    });
  }

  async function decideChange(id: number, action: "approve" | "decline") {
    setReqBusy(id);
    setChangeNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/changes/requests/" + id + "/decide",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setChangeNote(payload.error.message || "Could not save the decision.");
      } else {
        setChangeNote(
          action === "approve"
            ? "Approved - the customer has been notified on WhatsApp."
            : "Declined - the customer has been notified on WhatsApp."
        );
      }
      const refresh = await fetch(
        "/api/omniflow/portal/changes/requests?status=pending",
        { cache: "no-store" }
      );
      const next = await refresh.json().catch(() => null);
      if (next && Array.isArray(next.requests)) setChangeReqs(next.requests);
    } catch {
      setChangeNote("Could not save the decision - try again.");
    } finally {
      setReqBusy(0);
    }
  }

  async function createLink() {
    if (composer.busy) return;
    const items = composer.rows
      .map((row) => ({
        name: row.name.trim(),
        qty: Math.floor(Number(row.qty)),
        price: Math.round(Number(row.price) * 100) / 100,
      }))
      .filter(
        (row) =>
          row.name.length > 0
          && Number.isFinite(row.qty) && row.qty >= 1
          && Number.isFinite(row.price) && row.price >= 0
      );
    if (!composer.contact.trim() || !items.length) return;
    updateComposer({ busy: true });
    try {
      const result = await getJson<{ ok: boolean }>(
        "/api/omniflow/portal/checkout/links",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_id: composer.contact.trim(),
            title: composer.title.trim(),
            items,
            expires_in_days:
              composer.expiry === "" ? null : Number(composer.expiry),
            discount_amount:
              composer.discount === ""
                ? null
                : Math.max(0, Number(composer.discount) || 0),
          }),
        }
      );
      if (result === null || !result.ok) return;
      setComposer(EMPTY_COMPOSER);
      await load();
    } catch {
      return;
    } finally {
      updateComposer({ busy: false });
    }
  }

  function openTracking(link: CheckoutLink) {
    setTrackFor(link.id);
    setTrackCourier(link.courier || "");
    setTrackNumber(link.trackingNumber || "");
  }

  async function saveTracking() {
    if (trackBusy || trackFor === null) return;
    const number = trackNumber.trim();
    if (!number) return;
    setTrackBusy(true);
    try {
      await getJson(
        "/api/omniflow/portal/checkout/links/" + trackFor + "/tracking",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courier: trackCourier.trim(),
            tracking_number: number,
          }),
        }
      );
      setTrackFor(null);
      await load();
    } catch {
      return;
    } finally {
      setTrackBusy(false);
    }
  }

  async function shareLink(link: CheckoutLink) {
    const origin =
      typeof window === "undefined" ? "" : window.location.origin;
    const due = dueOf(link);
    const paid = link.paidAmount || 0;
    const parts = [
      "Assalam o alaikum!",
      link.title ? "Your order '" + link.title + "'" : "Your order",
      "- " + link.total + ".",
      paid > 0 && due > 0
        ? "Advance " + paid + " received, due " + due + " on delivery."
        : "",
      "Pay or track it here: " + origin + "/c/" + link.token,
    ].filter(Boolean);
    await getJson(
      "/api/omniflow/portal/checkout/links/" + link.id + "/share",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: parts.join(" ") }),
      }
    );
  }

  function startEdit(link: CheckoutLink) {
    setEditFor(link.id);
    setEditTitle(link.title || "");
    setEditItems(
      (link.items || []).map((item) => ({
        name: item.name,
        qty: String(item.qty),
        price: String(item.price),
      }))
    );
    setEditExpiry("");
    setEditDiscount(link.discount ? String(link.discount) : "");
    setAdvanceAmount("");
  }

  async function saveEdit() {
    if (editFor === null || editBusy) return;
    const items = editItems
      .map((item) => ({
        name: item.name.trim(),
        qty: Math.floor(Number(item.qty)),
        price: Math.round(Number(item.price) * 100) / 100,
      }))
      .filter(
        (item) =>
          item.name.length > 0
          && Number.isFinite(item.qty) && item.qty >= 1
          && Number.isFinite(item.price) && item.price >= 0
      );
    if (!items.length) return;
    setEditBusy(true);
    try {
      await getJson("/api/omniflow/portal/checkout/links/" + editFor + "/edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          items,
          expires_in_days:
            editExpiry === "" ? null : Math.max(0, Number(editExpiry)),
          discount_amount: Math.max(0, Number(editDiscount) || 0),
        }),
      });
      setEditFor(null);
      await load();
    } catch {
      return;
    } finally {
      setEditBusy(false);
    }
  }

  async function duplicateLink(link: CheckoutLink) {
    await getJson(
      "/api/omniflow/portal/checkout/links/" + link.id + "/duplicate",
      { method: "POST" }
    );
    await load();
  }const [staffing, setStaffing] = useState<StaffingForecast | null>(null);
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
    const [churnPayload, radarPayload, revenuePayload, itemsPayload, forecast, ideas, negotiation, checkout, listenRules, listenHits, routingRules, restockPayload, custPayload, prodPayload] =
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
        getJson<{ customers: CustomerAnalyticsRow[] }>(
          "/api/omniflow/portal/insights/customer-analytics?days=" + days
        ),
        getJson<{ products: ProductAnalyticsRow[] }>(
          "/api/omniflow/portal/insights/product-analytics?days=" + days
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
    setCustAnalytics(custPayload?.customers ?? []);
    setProdAnalytics(prodPayload?.products ?? []);
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

  async function markLink(
    link: CheckoutLink,
    status: string,
    returnReason?: string
  ) {
    setStatusNote("");
    setStatusNoteFor(null);
    const result = await getJson<
      | { ok: true }
      | { error: { message: string } }
    >("/api/omniflow/portal/checkout/links/" + link.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status,
        reason: returnReason,
        note: "",
      }),
    });
    if (result === null) {
      setStatusNoteFor(link.id);
      setStatusNote("Could not update - try again.");
      return;
    }
    if ("error" in result) {
      setStatusNoteFor(link.id);
      setStatusNote(result.error.message);
      return;
    }
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
        <div className="flex justify-end">
          <button
            onClick={() =>
              void downloadCsv(
                "/api/omniflow/portal/revenue/export",
                "omniflow-revenue.csv"
              )
            }
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.06]"
          >
            Export revenue CSV
          </button>
        </div>
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
          title="Customer insights"
          hint="Who buys again - and who deserves a VIP price next time."
        >
          {custAnalytics.length === 0 ? (
            <p className="text-xs text-slate-500">
              Paid orders appear here as customers come back.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {custAnalytics.slice(0, 4).map((row) => (
                <li
                  key={row.contact_id}
                  className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">
                      {row.contact_id}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {row.orders}
                      {row.orders === 1 ? " order" : " orders"} · avg{" "}
                      {row.avg_order}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] uppercase ${
                      row.tier === "vip"
                        ? "border-violet-400/25 bg-violet-400/[0.08] text-violet-300"
                        : row.tier === "repeat"
                          ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                          : "border-white/[0.08] bg-white/[0.02] text-slate-400"
                    }`}
                  >
                    {row.tier}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Top products"
          hint="What actually sells, from paid orders only."
        >
          {prodAnalytics.length === 0 ? (
            <p className="text-xs text-slate-500">
              Paid orders appear here.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {prodAnalytics.slice(0, 4).map((row) => (
                <li
                  key={row.name}
                  className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">
                      {row.name}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {row.qty_sold} sold · {row.orders}
                      {row.orders === 1 ? " order" : " orders"}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-medium text-slate-200">
                    {row.revenue}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Checkout links"
          hint="Shareable order summaries - the customer opens the link, you close the deal in chat."
        >
          {composer.open ? (
            <div className="mb-3 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] text-slate-400">
                    Customer WhatsApp ID
                  </span>
                  <input
                    type="text"
                    value={composer.contact}
                    onChange={(event) =>
                      updateComposer({ contact: event.target.value })
                    }
                    placeholder="92300xxxxxxx"
                    className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-slate-400">
                    Order title
                  </span>
                  <input
                    type="text"
                    value={composer.title}
                    onChange={(event) =>
                      updateComposer({ title: event.target.value })
                    }
                    placeholder="Eid bundle"
                    className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                  />
                </label>
              </div>
              <div className="mt-2 space-y-2">
                {catalogItems.filter((item) => item.isActive).length > 0 ? (
                  <div className="mb-2">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      From saved catalog
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {catalogItems
                        .filter((item) => item.isActive)
                        .slice(0, 12)
                        .map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => addCatalogRow(item)}
                            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-400/30 hover:text-cyan-200"
                          >
                            + {item.name}
                            {item.priceText ? " · " + item.priceText : ""}
                          </button>
                        ))}
                    </div>
                  </div>
                ) : null}
                {composer.rows.map((row, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[1fr_4rem_5rem_2rem] gap-2"
                  >
                    <input
                      type="text"
                      value={row.name}
                      onChange={(event) =>
                        updateRow(index, { name: event.target.value })
                      }
                      placeholder="Item"
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                    />
                    <input
                      type="number"
                      min={1}
                      value={row.qty}
                      onChange={(event) =>
                        updateRow(index, { qty: event.target.value })
                      }
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                    />
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.price}
                      onChange={(event) =>
                        updateRow(index, { price: event.target.value })
                      }
                      placeholder="Price"
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                    />
                    <button
                      onClick={() =>
                        updateComposer({
                          rows: composer.rows.filter(
                            (_, row2) => row2 !== index
                          ),
                        })
                      }
                      className="rounded-lg border border-white/[0.08] px-1 text-[10px] text-slate-500 hover:bg-white/[0.06]"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <button
                  onClick={() =>
                    updateComposer({
                      rows: [
                        ...composer.rows,
                        { name: "", qty: "1", price: "" },
                      ],
                    })
                  }
                  className="text-[11px] text-cyan-300 hover:text-cyan-200"
                >
                  + Add item
                </button>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-[11px] text-slate-400">
                    Discount (Rs)
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={composer.discount}
                      onChange={(event) =>
                        updateComposer({ discount: event.target.value })
                      }
                      placeholder="0"
                      className="w-20 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-[11px] text-slate-400">
                    Expires in
                    <select
                      value={composer.expiry}
                      onChange={(event) =>
                        updateComposer({ expiry: event.target.value })
                      }
                      className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                    >
                      <option value="">Never</option>
                      <option value="3">3 days</option>
                      <option value="7">7 days</option>
                      <option value="14">14 days</option>
                      <option value="30">30 days</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => void createLink()}
                  disabled={composer.busy}
                  className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.1] px-3 py-1.5 text-[11px] font-medium text-cyan-200 hover:bg-cyan-400/[0.18] disabled:opacity-50"
                >
                  {composer.busy ? "Creating…" : "Create link"}
                </button>
                <button
                  onClick={() => setComposer(EMPTY_COMPOSER)}
                  className="rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-slate-400 hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setComposer({ ...EMPTY_COMPOSER, open: true })}
              className="mb-3 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-[11px] font-medium text-cyan-200 hover:bg-cyan-400/[0.15]"
            >
              + New checkout link
            </button>
          )}
          {changeReqs.length > 0 ? (
            <div className="mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3">
              <p className="text-xs font-medium text-amber-200">
                Customer change requests ({changeReqs.length})
              </p>
              <ul className="mt-2 space-y-1.5">
                {changeReqs.slice(0, 5).map((req) => (
                  <li
                    key={req.id}
                    className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                  >
                    <p className="text-xs text-slate-200">
                      {req.kind === "address" ? "Address change" : "Cancellation"}
                      {req.title ? " · " + req.title : ""}
                    </p>
                    {req.kind === "address" ? (
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        New address: {req.addressText}
                      </p>
                    ) : null}
                    {req.message ? (
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Note: {req.message}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button
                        onClick={() => void decideChange(req.id, "approve")}
                        disabled={reqBusy === req.id}
                        className="rounded-md border border-emerald-400/30 bg-emerald-400/[0.1] px-2 py-1 text-[10px] font-medium text-emerald-200 hover:bg-emerald-400/[0.2] disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void decideChange(req.id, "decline")}
                        disabled={reqBusy === req.id}
                        className="rounded-md border border-white/[0.1] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06] disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {changeNote ? (
                <p className="mt-1.5 text-[10px] text-slate-400">{changeNote}</p>
              ) : null}
            </div>
          ) : null}
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
                        {link.status === "open" && (link.viewCount || 0) > 0
                          ? " · " + (link.viewCount || 0) + " views"
                          : ""}
                        {expiryLabel(link) ? " · " + expiryLabel(link) : ""}
                        {link.status === "open" && (link.paidAmount || 0) > 0
                          ? " · due " + dueOf(link)
                          : ""}
                        {link.status === "open" && (link.discount || 0) > 0
                          ? " · " + link.discount + " off"
                          : ""}
                        {link.status !== "open" && (link.trackingNumber || "") !== ""
                          ? " · " + (link.courier
                            ? link.courier + " "
                            : "") + link.trackingNumber
                          : ""}
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
                          <button
                            onClick={() => startEdit(link)}
                            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => void duplicateLink(link)}
                            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                          >
                            Duplicate
                          </button>
                          <button
                            onClick={() => void shareLink(link)}
                            className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-400/[0.14]"
                          >
                            Send on WhatsApp
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
                      {link.status === "paid"
                        || link.status === "shipped"
                        || link.status === "delivered" ? (
                        <button
                          onClick={() =>
                            setReturnFor(
                              returnFor === link.id ? null : link.id
                            )
                          }
                          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                        >
                          Returned
                        </button>
                      ) : null}
                      {link.status !== "open" ? (
                        <button
                          onClick={() => openTracking(link)}
                          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                        >
                          Tracking
                        </button>
                      ) : null}
                    </div>
                    {trackFor === link.id ? (
                      <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            value={trackCourier}
                            onChange={(event) =>
                              setTrackCourier(event.target.value)
                            }
                            placeholder="Courier (TCS, Leopards...)"
                            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                          />
                          <input
                            type="text"
                            value={trackNumber}
                            onChange={(event) =>
                              setTrackNumber(event.target.value)
                            }
                            placeholder="Tracking #"
                            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                          />
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            onClick={() => void saveTracking()}
                            disabled={trackBusy}
                            className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.08] px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-cyan-400/[0.15] disabled:opacity-50"
                          >
                            {trackBusy ? "Saving..." : "Save tracking"}
                          </button>
                          <button
                            onClick={() => setTrackFor(null)}
                            className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-[11px] text-slate-400 hover:bg-white/[0.06]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {statusNoteFor === link.id && statusNote ? (
                      <p className="mt-1 text-[10px] text-rose-300">
                        {statusNote}
                      </p>
                    ) : null}
                    {editFor === link.id ? (
                      <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
                        <label className="block">
                          <span className="text-[11px] text-slate-400">
                            Title
                          </span>
                          <input
                            type="text"
                            value={editTitle}
                            onChange={(event) =>
                              setEditTitle(event.target.value)
                            }
                            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                          />
                        </label>
                        <label className="mt-2 block">
                          <span className="text-[11px] text-slate-400">
                            Link expiry
                          </span>
                          <select
                            value={editExpiry}
                            onChange={(event) =>
                              setEditExpiry(event.target.value)
                            }
                            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                          >
                            <option value="">Keep current</option>
                            <option value="0">No expiry</option>
                            <option value="3">3 days</option>
                            <option value="7">7 days</option>
                            <option value="14">14 days</option>
                            <option value="30">30 days</option>
                          </select>
                        </label>
                        <div className="mt-2 rounded-lg border border-white/[0.06] p-2">
                          <span className="text-[11px] text-slate-400">
                            Advance received (Rs)
                          </span>
                          <div className="mt-1 flex items-center gap-2">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={advanceAmount}
                              onChange={(event) =>
                                setAdvanceAmount(event.target.value)
                              }
                              placeholder="e.g. 500"
                              className="w-24 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                            />
                            <button
                              onClick={() => void recordAdvance(link)}
                              disabled={advanceBusy}
                              className="rounded-lg border border-emerald-400/30 bg-emerald-400/[0.08] px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-400/[0.14] disabled:opacity-50"
                            >
                              {advanceBusy ? "Recording…" : "Record"}
                            </button>
                            <span className="text-[10px] text-slate-500">
                              Full advance marks the link paid.
                            </span>
                          </div>
                          {advanceNote ? (
                            <p className="mt-1 text-[10px] text-rose-300">
                              {advanceNote}
                            </p>
                          ) : null}
                        </div>
                        <div className="mt-2 space-y-2">
                          {editItems.map((item, index) => (
                            <div
                              key={index}
                              className="grid grid-cols-[1fr_4rem_5rem] gap-2"
                            >
                              <input
                                type="text"
                                value={item.name}
                                onChange={(event) =>
                                  setEditItems((prev) =>
                                    prev.map((row, row2) =>
                                      row2 === index
                                        ? { ...row, name: event.target.value }
                                        : row
                                    )
                                  )
                                }
                                placeholder="Item"
                                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                              />
                              <input
                                type="number"
                                min={1}
                                value={item.qty}
                                onChange={(event) =>
                                  setEditItems((prev) =>
                                    prev.map((row, row2) =>
                                      row2 === index
                                        ? { ...row, qty: event.target.value }
                                        : row
                                    )
                                  )
                                }
                                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                              />
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={item.price}
                                onChange={(event) =>
                                  setEditItems((prev) =>
                                    prev.map((row, row2) =>
                                      row2 === index
                                        ? { ...row, price: event.target.value }
                                        : row
                                    )
                                  )
                                }
                                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-slate-200 focus:border-white/20 focus:outline-none"
                              />
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            onClick={() => void saveEdit()}
                            disabled={editBusy}
                            className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.08] px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-400/[0.14] disabled:opacity-50"
                          >
                            {editBusy ? "Saving…" : "Save changes"}
                          </button>
                          <button
                            onClick={() => setEditFor(null)}
                            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-400 hover:bg-white/[0.06]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {returnFor === link.id ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {RETURN_REASONS.map(([code, label]) => (
                          <button
                            key={code}
                            onClick={() => {
                              setReturnFor(null);
                              void markLink(link, "returned", code);
                            }}
                            className="rounded-lg border border-amber-400/25 bg-amber-400/[0.08] px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-400/[0.14]"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <OrderUpdatesSettings />

        <CheckoutReturnsCard />

        <DigestCard />

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
