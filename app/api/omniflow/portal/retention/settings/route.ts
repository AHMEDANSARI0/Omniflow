import { getLoyaltySettings, saveLoyaltySettings } from "../../../../../../lib/omniflow/portal";
import type { LoyaltyTier } from "../../../../../../lib/omniflow/portal";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 600) : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function tiers(value: unknown): LoyaltyTier[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 5).map((item) => {
    const row = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      key: "",
      label: typeof row.label === "string" ? row.label.slice(0, 40) : "",
      minOrders: typeof row.minOrders === "number" ? row.minOrders : Number.NaN,
      minSpend: typeof row.minSpend === "number" ? row.minSpend : Number.NaN,
      coupon: typeof row.coupon === "string" ? row.coupon.slice(0, 40) : "",
    };
  });
}

/** §238 loyalty tiers, automatic messages and their limits. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getLoyaltySettings(accessToken)));
}

/** Owners / admins only (the Control Plane enforces it); known keys only. */
export async function PUT(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    return serviceResponse(
      await saveLoyaltySettings(accessToken, {
        autoReorder: flag(body.autoReorder),
        autoWinback: flag(body.autoWinback),
        brainContext: flag(body.brainContext),
        dailyCap: whole(body.dailyCap),
        cooldownDays: whole(body.cooldownDays),
        windowStart: whole(body.windowStart),
        windowEnd: whole(body.windowEnd),
        tplReorder: text(body.tplReorder),
        tplWinback: text(body.tplWinback),
        tplOffer: text(body.tplOffer),
        tiers: tiers(body.tiers),
      })
    );
  }, request);
}
