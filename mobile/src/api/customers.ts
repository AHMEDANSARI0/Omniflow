/**
 * §278 P3 customers + customer analytics. Backed by the existing CP portal
 * endpoints (portal_conversations.py /customers and portal_analytics.py
 * /insights/customer-analytics). Fail-soft schemas: junk or missing fields
 * degrade to safe defaults instead of crashing a screen.
 */

import { z } from "zod";
import { api } from "@/api/client";

const n0 = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0))
  .catch(0);

const n2 = z
  .number()
  .nullish()
  .transform((v) =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0,
  )
  .catch(0);

const str = (fallback = "") =>
  z
    .string()
    .nullish()
    .transform((v) => (typeof v === "string" ? v : fallback))
    .catch(fallback);

export const customerSchema = z.object({
  contact_id: str(),
  name: str(),
  channels: z.array(z.string()).catch([]),
  conversation_count: n0,
  open_count: n0,
  last_message_at: str(),
  last_message_preview: str(),
  lead_temp: z.enum(["hot", "warm", "cold"]).catch("cold"),
  tags: z.array(z.string()).catch([]),
});
export type Customer = z.infer<typeof customerSchema>;

export const customersSchema = z.object({
  customers: z.array(customerSchema).catch([]),
});
export type Customers = z.infer<typeof customersSchema>;

export async function listCustomers(q = ""): Promise<Customers> {
  const suffix = q ? "?q=" + encodeURIComponent(q.slice(0, 100)) : "";
  const data = await api.get<unknown>("/api/v1/portal/customers" + suffix);
  return customersSchema.parse(data ?? {});
}

export const customerTierSchema = z.object({
  contact_id: str(),
  orders: n0,
  spend: n2,
  avg_order: n2,
  tier: z.enum(["new", "repeat", "vip"]).catch("new"),
});
export type CustomerTierEntry = z.infer<typeof customerTierSchema>;

export const customerAnalyticsSchema = z.object({
  days: n0,
  customers: z.array(customerTierSchema).catch([]),
  languages: z
    .array(z.object({ lang: str(), count: n0 }))
    .catch([]),
  tiers: z
    .object({ new: n0, repeat: n0, vip: n0 })
    .catch({ new: 0, repeat: 0, vip: 0 }),
  repeat_share: n2,
});
export type CustomerAnalytics = z.infer<typeof customerAnalyticsSchema>;

export async function fetchCustomerAnalytics(
  days = 30,
): Promise<CustomerAnalytics> {
  const safe = [7, 30, 90].includes(days) ? days : 30;
  const data = await api.get<unknown>(
    `/api/v1/portal/insights/customer-analytics?days=${safe}`,
  );
  return customerAnalyticsSchema.parse(data ?? {});
}
