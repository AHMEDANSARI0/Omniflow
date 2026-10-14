// §261: owner's client billing. Server-rendered; the forms post to actions.ts, so no
// client script is needed. Money and dates come from the Control Plane.
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { getAdminBilling } from "../../../../../lib/omniflow/admin-billing";
import {
  COMMISSION_BASES,
  EXPIRY_MODES,
  commissionBaseLabel,
  expiryModeLabel,
  expiryStateLabel,
  expiryTone,
  formatMoney,
  hasPaymentDue,
  kindLabel,
  type BillingClient,
  type BillingOverview,
  type BillingPayment,
  type BillingSettings,
} from "../../../../../lib/omniflow/admin-billing-core";
import {
  deleteBillingPaymentAction,
  recordBillingPaymentAction,
  saveBillingClientAction,
  saveBillingSettingsAction,
} from "./actions";

export const dynamic = "force-dynamic";

const INPUT = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const LABEL = "block text-xs font-medium text-ink-2";
const PRIMARY =
  "cursor-pointer rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white hover:opacity-90";
const DANGER =
  "cursor-pointer rounded-lg border border-danger/30 bg-danger-soft px-2.5 py-1 text-xs font-medium text-danger";
const TONE = {
  ok: "bg-soft text-ink-2",
  warn: "bg-warn-soft text-ink",
  bad: "bg-danger-soft text-danger",
  muted: "bg-soft text-ink-3",
} as const;

export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const params = await searchParams;
  const { overview, error } = await getAdminBilling();
  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/admin"
        className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-ink-3 hover:text-ink"
      >
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        Dashboard
      </Link>
      <header className="mb-6 mt-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Client billing</h1>
        <p className="mt-1.5 text-sm text-ink-3">
          What each client owes, what is paid, and when each plan expires. Payments are
          recorded by hand for now; a payment gateway comes later.
        </p>
      </header>
      {params.notice ? <Banner tone="ok">{params.notice}</Banner> : null}
      {params.error ? <Banner tone="bad">{params.error}</Banner> : null}
      {overview ? <BillingBody overview={overview} /> : <Banner tone="bad">{error}</Banner>}
    </div>
  );
}

function Banner({ tone, children }: { tone: "ok" | "bad"; children: ReactNode }) {
  const style =
    tone === "bad"
      ? "border-danger/30 bg-danger-soft text-danger"
      : "border-line bg-soft text-ink";
  return (
    <p role={tone === "bad" ? "alert" : "status"} className={`mb-5 rounded-lg border px-3 py-2 text-sm ${style}`}>
      {children}
    </p>
  );
}

function BillingBody({ overview }: { overview: BillingOverview }) {
  const { settings, totals, clients, today } = overview;
  const money = (amount: number) => formatMoney(amount, settings.currency);
  return (
    <>
      <section aria-label="Billing summary" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Payment pending"
          value={money(totals.payment_pending)}
          note={"Fees " + money(totals.fee_pending) + " · commission " + money(totals.commission_pending)}
        />
        <Stat
          label="Clients"
          value={String(totals.clients)}
          note={totals.subscription + " subscription · " + totals.commission + " commission · " + totals.free + " free · " + totals.unset + " not set up"}
        />
        <Stat
          label="Expiring soon"
          value={String(totals.expiring_soon)}
          note={totals.grace + " in grace period · " + totals.expired + " expired"}
        />
        <Stat
          label="Moved to Free"
          value={String(totals.dropped_to_free)}
          note="Expired past the rule you chose below"
        />
      </section>
      <SettingsPanel settings={settings} />
      <section aria-labelledby="billing-clients" className="rounded-2xl border border-line bg-white p-5 shadow-card">
        <h2 id="billing-clients" className="text-sm font-semibold text-ink">Clients</h2>
        <p className="mt-1 text-xs text-ink-3">
          Amounts count from each client&apos;s billing start date up to today. Payments in that
          range reduce what is pending. Deleting a payment is immediate.
        </p>
        {clients.length === 0 ? (
          <p className="mt-4 text-sm text-ink-3">
            No clients yet. A client appears here after saving a business profile, or once a billing plan is set.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {clients.map((client) => (
              <ClientRow key={client.client_id} client={client} settings={settings} today={today} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wider text-ink-3">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{note}</p>
    </div>
  );
}

function SettingsPanel({ settings }: { settings: BillingSettings }) {
  return (
    <section aria-labelledby="billing-rules" className="mb-6 rounded-2xl border border-line bg-white p-5 shadow-card">
      <h2 id="billing-rules" className="text-sm font-semibold text-ink">Billing rules</h2>
      <p className="mt-1 text-xs text-ink-3">These rules apply to every client. They are saved in the Control Plane database.</p>
      <form action={saveBillingSettingsAction} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className={LABEL}>
          Currency (3-letter code)
          <input name="currency" required maxLength={3} pattern="[A-Za-z]{3}" defaultValue={settings.currency} className={INPUT} />
        </label>
        <label className={LABEL}>
          Commission base
          <select name="commission_base" defaultValue={settings.commission_base} className={INPUT}>
            {COMMISSION_BASES.map((base) => (
              <option key={base} value={base}>{commissionBaseLabel(base)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          When a plan expires
          <select name="expiry_mode" defaultValue={settings.expiry_mode} className={INPUT}>
            {EXPIRY_MODES.map((mode) => (
              <option key={mode} value={mode}>{expiryModeLabel(mode)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Grace days (used by &quot;grace, then Free&quot;)
          <input name="grace_days" type="number" min={0} max={365} required defaultValue={settings.grace_days} className={INPUT} />
        </label>
        <label className={LABEL}>
          &quot;Expiring soon&quot; window (days)
          <input name="expiring_soon_days" type="number" min={0} max={365} required defaultValue={settings.expiring_soon_days} className={INPUT} />
        </label>
        <div className="flex items-end">
          <button type="submit" className={PRIMARY}>Save rules</button>
        </div>
      </form>
    </section>
  );
}

function expiryNote(client: BillingClient): string {
  if (client.days_left === null) return "";
  if (client.days_left >= 0) return client.days_left + " days left";
  return -client.days_left + " days ago";
}

function ClientRow({ client, settings, today }: { client: BillingClient; settings: BillingSettings; today: string }) {
  const money = (amount: number) => formatMoney(amount, settings.currency);
  return (
    <li>
      <details className="py-3">
        <summary className="grid cursor-pointer gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto] sm:items-center">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-ink">{client.name}</span>
            <span className="block text-xs text-ink-3">Client #{client.client_id}</span>
          </span>
          <span className="min-w-0 text-xs text-ink-2">
            <span className="block">{kindLabel(client.kind)}</span>
            {client.plan_label ? <span className="block truncate text-ink-3">{client.plan_label}</span> : null}
          </span>
          <span className={"text-sm " + (hasPaymentDue(client) ? "font-semibold text-ink" : "text-ink-3")}>
            {money(client.payment_pending)}
          </span>
          <span className="text-xs text-ink-2">
            <span className="block">{client.expires_on ?? "No expiry date"} {expiryNote(client)}</span>
            <span className={"mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium " + TONE[expiryTone(client.expiry_state)]}>
              {expiryStateLabel(client.expiry_state)}
            </span>
          </span>
          <span className="text-xs font-medium text-brand">Manage</span>
        </summary>
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <PlanForm client={client} today={today} />
          <div className="space-y-5">
            <Ledger client={client} money={money} />
            <PaymentForm client={client} today={today} />
            <Payments payments={client.payments} money={money} />
          </div>
        </div>
      </details>
    </li>
  );
}

function PlanForm({ client, today }: { client: BillingClient; today: string }) {
  return (
    <form action={saveBillingClientAction} className="space-y-3 rounded-xl border border-line p-4">
      <input type="hidden" name="client_id" value={client.client_id} />
      <h3 className="text-sm font-semibold text-ink">Plan</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Billing kind
          <select name="kind" defaultValue={client.kind === "unset" ? "free" : client.kind} className={INPUT}>
            <option value="free">Free</option>
            <option value="subscription">Subscription (fixed fee)</option>
            <option value="commission">Commission (% of sales)</option>
          </select>
        </label>
        <label className={LABEL}>
          Plan name (optional)
          <input name="plan_label" maxLength={80} defaultValue={client.plan_label} className={INPUT} />
        </label>
        <label className={LABEL}>
          Fee per period
          <input name="fee_amount" inputMode="decimal" defaultValue={String(client.fee_amount)} className={INPUT} />
        </label>
        <label className={LABEL}>
          Period length (days)
          <input name="period_days" type="number" min={1} max={3660} required defaultValue={client.period_days ?? ""} className={INPUT} />
        </label>
        <label className={LABEL}>
          Commission on sales (%)
          <input name="commission_percent" inputMode="decimal" defaultValue={String(client.commission_percent)} className={INPUT} />
        </label>
        <label className={LABEL}>
          Billing starts (counted from)
          <input name="billed_from" type="date" required defaultValue={client.billed_from ?? today} className={INPUT} />
        </label>
        <label className={LABEL}>
          Paid until (expiry date)
          <input name="expires_on" type="date" defaultValue={client.expires_on ?? ""} className={INPUT} />
        </label>
        <label className={LABEL}>
          Note
          <input name="note" maxLength={300} defaultValue={client.note} className={INPUT} />
        </label>
      </div>
      <button type="submit" className={PRIMARY}>Save plan</button>
    </form>
  );
}

function Ledger({ client, money }: { client: BillingClient; money: (amount: number) => string }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="text-sm font-semibold text-ink">Amounts since billing started</h3>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-ink-3">Subscription due</dt>
        <dd className="text-right text-ink">{money(client.fee_due)}</dd>
        <dt className="text-ink-3">Subscription paid</dt>
        <dd className="text-right text-ink">{money(client.fee_paid)}</dd>
        <dt className="text-ink-3">Sales counted for commission</dt>
        <dd className="text-right text-ink">{money(client.sales_base)}</dd>
        <dt className="text-ink-3">Commission due</dt>
        <dd className="text-right text-ink">{money(client.commission_due)}</dd>
        <dt className="text-ink-3">Commission paid</dt>
        <dd className="text-right text-ink">{money(client.commission_paid)}</dd>
      </dl>
      {client.dropped_to_free ? (
        <p className="mt-3 text-xs text-danger">
          The plan expired past the rule you chose, so the client panel shows the Free plan.
        </p>
      ) : null}
    </div>
  );
}

function PaymentForm({ client, today }: { client: BillingClient; today: string }) {
  return (
    <form action={recordBillingPaymentAction} className="space-y-3 rounded-xl border border-line p-4">
      <input type="hidden" name="client_id" value={client.client_id} />
      <h3 className="text-sm font-semibold text-ink">Record a payment</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Pays for
          <select name="kind" defaultValue={client.kind === "commission" ? "commission" : "fee"} className={INPUT}>
            <option value="fee">Subscription fee</option>
            <option value="commission">Commission</option>
          </select>
        </label>
        <label className={LABEL}>
          Amount
          <input name="amount" inputMode="decimal" required className={INPUT} />
        </label>
        <label className={LABEL}>
          Received on
          <input name="received_on" type="date" required max={today} defaultValue={today} className={INPUT} />
        </label>
        <label className={LABEL}>
          Method (optional)
          <input name="method" maxLength={40} placeholder="Bank transfer, cash" className={INPUT} />
        </label>
        <label className={LABEL}>
          Reference (optional)
          <input name="reference" maxLength={80} className={INPUT} />
        </label>
        <label className={LABEL}>
          Note (optional)
          <input name="note" maxLength={200} className={INPUT} />
        </label>
      </div>
      <button type="submit" className={PRIMARY}>Record payment</button>
    </form>
  );
}

function Payments({ payments, money }: { payments: BillingPayment[]; money: (amount: number) => string }) {
  if (payments.length === 0) {
    return <p className="text-xs text-ink-3">No payments recorded yet.</p>;
  }
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="text-sm font-semibold text-ink">Latest payments</h3>
      <ul className="mt-3 divide-y divide-line">
        {payments.map((payment) => (
          <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
            <span className="text-ink-2">
              {payment.received_on} · {payment.kind === "fee" ? "Subscription fee" : "Commission"} · {money(payment.amount)}
              {payment.method ? " · " + payment.method : ""}
              {payment.reference ? " · " + payment.reference : ""}
            </span>
            <form action={deleteBillingPaymentAction}>
              <input type="hidden" name="payment_id" value={payment.id} />
              <button type="submit" className={DANGER}>Delete</button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
