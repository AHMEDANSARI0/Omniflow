"use client";

import { useCallback, useEffect, useState } from "react";

import type { SalesLeadView, SalesQuote } from "../../../../../lib/omniflow/portal";

const ghostBtn =
  "rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-3 transition-colors duration-300 hover:text-ink disabled:opacity-50";
const field = "rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink";
const LABEL_TONE: Record<string, string> = {
  hot: "text-emerald-700",
  warm: "text-amber-700",
  cold: "text-ink-3",
};

function money(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function words(value: string): string {
  return value.replace(/_/g, " ");
}

type Row = { catalogId: number; qty: number };

/**
 * §237 sales card: what the customer already told us, what to ask next,
 * the concerns they raised (with the owner's approved answer to copy) and
 * a catalog-priced quote that becomes a normal checkout link.
 */
export default function SalesCard({ conversationId }: { conversationId: number }) {
  const [view, setView] = useState<SalesLeadView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [discount, setDiscount] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [quote, setQuote] = useState<SalesQuote | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/sales/conversations/" + String(conversationId), {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const data = (await response.json()) as SalesLeadView;
      setView(data);
      setFailed(false);
      if (data.lead.label === "hot" || data.lead.concerns.some((item) => item.current)) setOpen(true);
    } catch {
      setFailed(true);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed || !view) return null;
  const lead = view.lead;
  if (!lead.known.length && !lead.concerns.length && !lead.quotes.length && lead.score === 0) return null;

  function startQuote() {
    if (!view) return;
    const first = view.lead.products.find((item) => view.catalog.some((choice) => choice.id === item.id));
    const qty = Number(view.lead.known.find((item) => item.key === "quantity")?.value) || 1;
    setRows([{ catalogId: first ? first.id : view.catalog[0]?.id ?? 0, qty }]);
    setDiscount("");
    setDays(view.quoteDays ? String(view.quoteDays) : "");
    setQuote(null);
    setNotice(null);
    setBuilding(true);
  }

  function priceOf(row: Row): number {
    const item = view?.catalog.find((choice) => choice.id === row.catalogId);
    return item ? item.price * row.qty : 0;
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied.");
    } catch {
      setNotice("Copy is not available in this browser.");
    }
  }

  async function createQuote() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/sales/quotes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          items: rows.filter((row) => row.catalogId > 0),
          discountPercent: Number(discount) || 0,
          expiresInDays: Number.parseInt(days, 10) || 0,
          title: "",
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { link?: SalesQuote; error?: { message?: string } }
        | null;
      if (response.ok && payload?.link) {
        setQuote(payload.link);
        setBuilding(false);
        void load();
      } else {
        setNotice(payload?.error?.message || "The quote could not be created. Try again shortly.");
      }
    } catch {
      setNotice("Could not reach the workspace. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  function quoteUrl(token: string): string {
    return (typeof window === "undefined" ? "" : window.location.origin) + "/c/" + token;
  }

  async function sendQuote() {
    if (!quote || busy) return;
    setBusy(true);
    setNotice(null);
    const message =
      "Assalam-o-Alaikum! Aap ka quote '" + quote.title + "': " + money(quote.total) +
      ". Order yahan confirm karein: " + quoteUrl(quote.token);
    try {
      const response = await fetch(
        "/api/omniflow/portal/checkout/links/" + String(quote.id) + "/share",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }
      );
      setNotice(response.ok ? "Sent in this chat." : "Sending failed. Copy the link instead.");
    } catch {
      setNotice("Could not reach the workspace. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  const subtotal = rows.reduce((sum, row) => sum + priceOf(row), 0);
  const off = Math.min(Number(discount) || 0, view.maxDiscountPercent);

  return (
    <section className="mb-4 rounded-2xl border border-line bg-white shadow-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-ink">Sales</h2>
          <p className="mt-0.5 text-xs text-ink-2">
            <span className={LABEL_TONE[lead.label]}>{lead.label === "hot" ? "Hot lead" : lead.label === "warm" ? "Warm lead" : "Cold lead"}</span>
            {" \u00b7 score " + lead.score + " \u00b7 " + (lead.bought ? "bought" : words(lead.stageHint))}
            {lead.askNext && !lead.bought ? " \u00b7 ask for: " + lead.askNext.toLowerCase() : ""}
          </p>
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} className={ghostBtn}>
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        <div className="mt-3 space-y-3 text-xs">
          {lead.known.length > 0 || lead.missing.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {lead.known.map((item) => (
                <span key={item.key} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-2">
                  {item.label + ": " + item.value}
                </span>
              ))}
              {lead.missing.map((item) => (
                <span key={item.key} className="rounded-full border border-dashed border-line px-2 py-0.5 text-[10px] text-ink-3">
                  {item.label + "?"}
                </span>
              ))}
            </div>
          ) : null}

          {lead.concerns.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Concerns raised</p>
              <ul className="mt-1 space-y-1.5">
                {lead.concerns.map((item) => (
                  <li key={item.kind} className="rounded-lg bg-soft px-2.5 py-1.5">
                    <p className={item.current ? "font-medium text-ink" : "text-ink-2"}>
                      {item.label}
                      {item.current ? " \u00b7 latest message" : ""}
                    </p>
                    {item.approvedAnswer ? (
                      <div className="mt-1 flex items-start justify-between gap-2">
                        <p className="text-ink-2">{item.approvedAnswer}</p>
                        <button type="button" onClick={() => void copy(item.approvedAnswer)} className={ghostBtn}>
                          Copy
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 text-ink-3">
                        {"No approved answer yet \u00b7 "}
                        <a href="/dashboard/sales" className="text-brand hover:underline">
                          add one on the Sales desk
                        </a>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {lead.quotes.length > 0 ? (
            <div className="space-y-0.5 text-ink-3">
              {lead.quotes.map((item) => (
                <p key={item.id}>
                  {(item.title || "Link #" + item.id) + " \u00b7 " + money(item.total) + " \u00b7 " + words(item.status)}
                </p>
              ))}
            </div>
          ) : null}

          {quote ? (
            <div className="rounded-lg border border-brand/20 bg-brand-soft px-3 py-2">
              <p className="text-ink">
                {quote.title + " \u00b7 " + money(quote.total)}
                {quote.discount ? " (" + money(quote.discount) + " off)" : ""}
              </p>
              <p className="mt-1 break-all text-ink-3">{quoteUrl(quote.token)}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void sendQuote()} disabled={busy} className={ghostBtn}>
                  Send in chat
                </button>
                <button type="button" onClick={() => void copy(quoteUrl(quote.token))} className={ghostBtn}>
                  Copy link
                </button>
              </div>
            </div>
          ) : null}

          {building ? (
            <div className="space-y-2 rounded-lg border border-line p-3">
              {rows.map((row, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <select
                    value={row.catalogId}
                    onChange={(event) =>
                      setRows(rows.map((item, i) => (i === index ? { ...item, catalogId: Number(event.target.value) } : item)))
                    }
                    className={field + " min-w-0 flex-1"}
                    aria-label="Product"
                  >
                    {view.catalog.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name + " \u00b7 " + money(item.price)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={row.qty}
                    onChange={(event) =>
                      setRows(rows.map((item, i) => (i === index ? { ...item, qty: Math.max(1, Number(event.target.value) || 1) } : item)))
                    }
                    className={field + " w-16"}
                    aria-label="Quantity"
                  />
                  {rows.length > 1 ? (
                    <button type="button" onClick={() => setRows(rows.filter((_, i) => i !== index))} className={ghostBtn}>
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                {rows.length < 10 && view.catalog.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setRows([...rows, { catalogId: view.catalog[0].id, qty: 1 }])}
                    className={ghostBtn}
                  >
                    Add product
                  </button>
                ) : null}
                {view.canDiscount && view.maxDiscountPercent > 0 ? (
                  <label className="flex items-center gap-1 text-ink-3">
                    Discount %
                    <input
                      type="number"
                      min={0}
                      max={view.maxDiscountPercent}
                      value={discount}
                      onChange={(event) => setDiscount(event.target.value)}
                      className={field + " w-16"}
                    />
                    <span className="text-[10px]">{"max " + view.maxDiscountPercent}</span>
                  </label>
                ) : null}
                <label className="flex items-center gap-1 text-ink-3">
                  Valid days
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                    className={field + " w-14"}
                  />
                </label>
              </div>
              <p className="text-ink-2">
                {"Total " + money(subtotal - (subtotal * off) / 100)}
                {off ? " (" + off + "% off " + money(subtotal) + ")" : ""}
                <span className="text-ink-3">{" \u00b7 prices from your catalog"}</span>
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void createQuote()} disabled={busy || rows.length === 0} className={ghostBtn}>
                  {busy ? "Creating\u2026" : "Create quote link"}
                </button>
                <button type="button" onClick={() => setBuilding(false)} className={ghostBtn}>
                  Cancel
                </button>
              </div>
            </div>
          ) : !lead.bought ? (
            view.catalog.length > 0 ? (
              <button type="button" onClick={startQuote} className={ghostBtn}>
                Create quote
              </button>
            ) : (
              <p className="text-ink-3">Add prices to your catalog to send quotes from here.</p>
            )
          ) : null}
          {notice ? <p className="text-[11px] text-amber-700">{notice}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
