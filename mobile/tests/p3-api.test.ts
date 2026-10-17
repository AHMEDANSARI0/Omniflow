/**
 * §278 P3 schemas (customers, workflows, profile): every CP payload must
 * degrade to safe defaults - a missing or renamed field never crashes a
 * screen, and toggles/merges stay lossless.
 */

import {
  customerAnalyticsSchema,
  customersSchema,
} from "@/api/customers";
import {
  editableFromEnvelope,
  profileEnvelopeSchema,
} from "@/api/profile";
import { workflowListSchema } from "@/api/workflows";

describe("customers schemas (§278)", () => {
  it("normalizes a customers payload", () => {
    const parsed = customersSchema.parse({
      customers: [
        {
          contact_id: "+923001234567",
          name: "Ali",
          channels: ["whatsapp", "email"],
          conversation_count: 3,
          open_count: 1,
          last_message_at: "2026-10-15T10:00:00+00:00",
          lead_temp: "hot",
          tags: ["vip"],
        },
      ],
    });
    expect(parsed.customers).toHaveLength(1);
    expect(parsed.customers[0]!.lead_temp).toBe("hot");
    expect(parsed.customers[0]!.channels).toEqual(["whatsapp", "email"]);
  });

  it("defaults junk customers safely", () => {
    const parsed = customersSchema.parse({ customers: [{ lead_temp: "frozen" }] });
    expect(parsed.customers[0]!.lead_temp).toBe("cold");
    expect(parsed.customers[0]!.name).toBe("");
    expect(customersSchema.parse({}).customers).toEqual([]);
  });

  it("parses customer analytics with tiers and languages", () => {
    const parsed = customerAnalyticsSchema.parse({
      days: 30,
      customers: [
        { contact_id: "x", orders: 4, spend: 2500.555, avg_order: 625.13, tier: "vip" },
      ],
      languages: [{ lang: "ur", count: 9 }],
      tiers: { new: 2, repeat: 3, vip: 1 },
      repeat_share: 0.67,
    });
    expect(parsed.tiers.vip).toBe(1);
    expect(parsed.customers[0]!.spend).toBe(2500.55); // float-safe 2dp rounding
    expect(parsed.languages[0]!.lang).toBe("ur");
    expect(parsed.repeat_share).toBe(0.67);
  });

  it("defaults missing analytics sections", () => {
    const parsed = customerAnalyticsSchema.parse({ days: 7 });
    expect(parsed.tiers).toEqual({ new: 0, repeat: 0, vip: 0 });
    expect(parsed.customers).toEqual([]);
    expect(parsed.repeat_share).toBe(0);
  });
});

describe("workflows schema (§278)", () => {
  it("normalizes workflows with runs", () => {
    const parsed = workflowListSchema.parse({
      workflows: [
        {
          id: 12,
          name: "Welcome series",
          status: "active",
          trigger_type: "keyword",
          steps: 3,
          runs: { total: 40, live: 2, goals: 10, failed: 1, last_run_at: "2026-10-15T09:00:00Z" },
        },
      ],
    });
    const wf = parsed.workflows[0]!;
    expect(wf.id).toBe(12);
    expect(wf.status).toBe("active");
    expect(wf.runs.total).toBe(40);
  });

  it("clamps unknown statuses to draft and defaults runs", () => {
    const parsed = workflowListSchema.parse({
      workflows: [{ id: 7, status: "exploded" }],
    });
    const wf = parsed.workflows[0]!;
    expect(wf.id).toBe(7);
    expect(wf.status).toBe("draft");
    expect(wf.runs.total).toBe(0);
    expect(wf.runs.last_run_at).toBe("");
    expect(workflowListSchema.parse({}).workflows).toEqual([]);
  });
});

describe("profile schema (§278)", () => {
  it("keeps the full document and extracts editable fields", () => {
    const parsed = profileEnvelopeSchema.parse({
      profile: {
        business_name: "Ahmed Electronics",
        phone: "+92300",
        website_owned_key: { deep: true },
      },
      updated_at: "2026-10-15T12:00:00Z",
    });
    expect(parsed.profile.website_owned_key).toEqual({ deep: true });
    const editable = editableFromEnvelope(parsed);
    expect(editable.business_name).toBe("Ahmed Electronics");
    expect(editable.phone).toBe("+92300");
    expect(editable.tagline).toBe("");
    expect(editable.city).toBe("");
  });

  it("tolerates an empty or junk envelope", () => {
    const parsed = profileEnvelopeSchema.parse({});
    expect(parsed.profile).toEqual({});
    expect(parsed.updated_at).toBe("");
    const editable = editableFromEnvelope(parsed);
    expect(editable.business_name).toBe("");
  });
});
