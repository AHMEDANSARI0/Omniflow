// §261: pure helpers for the owner's client billing view. No server imports, so the
// Node harness can load this file directly. Every number and date comes from the
// Control Plane (portal_billing.py); nothing here sets a price or a currency.

export const BILLING_KINDS = ["free", "subscription", "commission", "unset"] as const;
export type BillingKind = (typeof BILLING_KINDS)[number];

export const COMMISSION_BASES = ["paid_before_cancel", "paid_net", "delivered"] as const;
export type CommissionBase = (typeof COMMISSION_BASES)[number];

export const EXPIRY_MODES = ["flag", "grace_then_free", "free_now"] as const;
export type ExpiryMode = (typeof EXPIRY_MODES)[number];

export const EXPIRY_STATES = [
  "none",
  "active",
  "expiring_soon",
  "grace",
  "expired",
  "dropped_free",
] as const;
export type ExpiryState = (typeof EXPIRY_STATES)[number];

export const PAYMENT_KINDS = ["fee", "commission"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export interface BillingSettings {
  currency: string;
  commission_base: CommissionBase;
  expiry_mode: ExpiryMode;
  grace_days: number;
  expiring_soon_days: number;
}

export interface BillingPayment {
  id: number;
  kind: PaymentKind;
  amount: number;
  received_on: string | null;
  method: string;
  reference: string;
  note: string;
}

export interface BillingClient {
  client_id: number;
  name: string;
  kind: BillingKind;
  plan_label: string;
  fee_amount: number;
  period_days: number | null;
  commission_percent: number;
  billed_from: string | null;
  expires_on: string | null;
  note: string;
  days_left: number | null;
  expiry_state: ExpiryState;
  dropped_to_free: boolean;
  fee_due: number;
  fee_paid: number;
  fee_pending: number;
  sales_base: number;
  commission_due: number;
  commission_paid: number;
  commission_pending: number;
  payment_pending: number;
  payments: BillingPayment[];
}

export interface BillingTotals {
  clients: number;
  subscription: number;
  commission: number;
  free: number;
  unset: number;
  fee_pending: number;
  commission_pending: number;
  payment_pending: number;
  expiring_soon: number;
  grace: number;
  expired: number;
  dropped_to_free: number;
}

export interface BillingOverview {
  settings: BillingSettings;
  today: string;
  clients: BillingClient[];
  totals: BillingTotals;
}

const KIND_LABELS: Record<BillingKind, string> = {
  free: "Free",
  subscription: "Subscription (fixed fee)",
  commission: "Commission (% of sales)",
  unset: "Not set up",
};

const BASE_LABELS: Record<CommissionBase, string> = {
  paid_before_cancel: "Paid sales, counting orders later cancelled",
  paid_net: "Paid sales, minus cancelled orders",
  delivered: "Delivered orders only",
};

const MODE_LABELS: Record<ExpiryMode, string> = {
  flag: "Flag only (plan stays on)",
  grace_then_free: "Grace days, then Free",
  free_now: "Free at once after expiry",
};

const STATE_LABELS: Record<ExpiryState, string> = {
  none: "No expiry set",
  active: "Active",
  expiring_soon: "Expiring soon",
  grace: "In grace period",
  expired: "Expired",
  dropped_free: "Moved to Free",
};

const STATE_TONES: Record<ExpiryState, "ok" | "warn" | "bad" | "muted"> = {
  none: "muted",
  active: "ok",
  expiring_soon: "warn",
  grace: "warn",
  expired: "bad",
  dropped_free: "bad",
};

export function kindLabel(kind: BillingKind): string {
  return KIND_LABELS[kind];
}

export function commissionBaseLabel(base: CommissionBase): string {
  return BASE_LABELS[base];
}

export function expiryModeLabel(mode: ExpiryMode): string {
  return MODE_LABELS[mode];
}

export function expiryStateLabel(state: ExpiryState): string {
  return STATE_LABELS[state];
}

export function expiryTone(state: ExpiryState): "ok" | "warn" | "bad" | "muted" {
  return STATE_TONES[state];
}

// The currency code comes from the saved settings. An unusable code falls back to
// the plain number, so a bad setting never breaks the page.
export function formatMoney(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return code + " " + amount.toFixed(2);
  }
}

export function hasPaymentDue(client: BillingClient): boolean {
  return client.payment_pending > 0;
}
