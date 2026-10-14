"use server";

// §261: server actions for the owner's client billing page. Forms post here; each
// action forwards the raw text to the Control Plane, which does the validation.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../../../lib/supabase/server";
import {
  deleteBillingPayment,
  recordBillingPayment,
  saveBillingClient,
  saveBillingSettings,
  type BillingResult,
} from "../../../../../lib/omniflow/admin-billing";

const PAGE = "/admin/customers/billing";

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

async function signedIn(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user);
}

function finish(result: BillingResult): never {
  revalidatePath(PAGE);
  const key = result.ok ? "notice" : "error";
  redirect(PAGE + "?" + key + "=" + encodeURIComponent(result.message));
}

const NOT_SIGNED_IN: BillingResult = {
  ok: false,
  message: "Sign in again to change client billing.",
};

export async function saveBillingSettingsAction(formData: FormData): Promise<void> {
  if (!(await signedIn())) finish(NOT_SIGNED_IN);
  finish(
    await saveBillingSettings({
      currency: field(formData, "currency"),
      commission_base: field(formData, "commission_base"),
      expiry_mode: field(formData, "expiry_mode"),
      grace_days: field(formData, "grace_days"),
      expiring_soon_days: field(formData, "expiring_soon_days"),
    })
  );
}

export async function saveBillingClientAction(formData: FormData): Promise<void> {
  if (!(await signedIn())) finish(NOT_SIGNED_IN);
  finish(
    await saveBillingClient(Number(field(formData, "client_id")), {
      kind: field(formData, "kind"),
      plan_label: field(formData, "plan_label"),
      fee_amount: field(formData, "fee_amount"),
      period_days: field(formData, "period_days"),
      commission_percent: field(formData, "commission_percent"),
      billed_from: field(formData, "billed_from"),
      expires_on: field(formData, "expires_on"),
      note: field(formData, "note"),
    })
  );
}

export async function recordBillingPaymentAction(formData: FormData): Promise<void> {
  if (!(await signedIn())) finish(NOT_SIGNED_IN);
  finish(
    await recordBillingPayment(Number(field(formData, "client_id")), {
      kind: field(formData, "kind"),
      amount: field(formData, "amount"),
      received_on: field(formData, "received_on"),
      method: field(formData, "method"),
      reference: field(formData, "reference"),
      note: field(formData, "note"),
    })
  );
}

export async function deleteBillingPaymentAction(formData: FormData): Promise<void> {
  if (!(await signedIn())) finish(NOT_SIGNED_IN);
  finish(await deleteBillingPayment(Number(field(formData, "payment_id"))));
}
