// §261: owner-side client billing calls to the Control Plane. The service key stays
// on the server (adminRequest); the browser only sees the saved result message.
import { adminRequest } from "./admin-control-plane";
import type { BillingOverview } from "./admin-billing-core";

export interface BillingResult {
  ok: boolean;
  message: string;
}

export interface BillingLoad {
  overview: BillingOverview | null;
  error: string | null;
}

const LOAD_ERROR = "Client billing data is not available right now. Check the Control Plane.";
const UNREACHABLE = "The Control Plane is not reachable. Nothing was saved.";

export async function getAdminBilling(): Promise<BillingLoad> {
  try {
    const response = await adminRequest("api/v1/admin/billing", { method: "GET" });
    const payload = (await response.json()) as BillingOverview;
    if (!payload || !Array.isArray(payload.clients) || !payload.totals) {
      return { overview: null, error: LOAD_ERROR };
    }
    return { overview: payload, error: null };
  } catch {
    return { overview: null, error: LOAD_ERROR };
  }
}

async function send(
  path: string,
  method: "PUT" | "POST" | "DELETE",
  body: unknown,
  success: string
): Promise<BillingResult> {
  try {
    const hasBody = body !== undefined;
    const response = await adminRequest(
      path,
      {
        method,
        headers: hasBody ? { "Content-Type": "application/json" } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
      },
      { passStatuses: [400, 403, 404, 503] }
    );
    if (response.ok) {
      return { ok: true, message: success };
    }
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return { ok: false, message: payload?.error?.message ?? "The change was not saved." };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function saveBillingSettings(body: Record<string, unknown>): Promise<BillingResult> {
  return send("api/v1/admin/billing/settings", "PUT", body, "Billing settings saved.");
}

export function saveBillingClient(
  clientId: number,
  body: Record<string, unknown>
): Promise<BillingResult> {
  if (!validId(clientId)) {
    return Promise.resolve({ ok: false, message: "Choose a valid client." });
  }
  return send(
    "api/v1/admin/billing/clients/" + clientId,
    "PUT",
    body,
    "Client billing plan saved."
  );
}

export function recordBillingPayment(
  clientId: number,
  body: Record<string, unknown>
): Promise<BillingResult> {
  if (!validId(clientId)) {
    return Promise.resolve({ ok: false, message: "Choose a valid client." });
  }
  return send(
    "api/v1/admin/billing/clients/" + clientId + "/payments",
    "POST",
    body,
    "Payment recorded."
  );
}

export function deleteBillingPayment(paymentId: number): Promise<BillingResult> {
  if (!validId(paymentId)) {
    return Promise.resolve({ ok: false, message: "Choose a valid payment." });
  }
  return send(
    "api/v1/admin/billing/payments/" + paymentId,
    "DELETE",
    undefined,
    "Payment deleted."
  );
}
