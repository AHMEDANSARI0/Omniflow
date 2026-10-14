import { createSalesQuote } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../../lib/omniflow/voice-vision-bff";

function whole(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : Number.NaN;
}

/** A catalog-priced quote (a normal checkout link) for one chat. */
export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const conversationId = whole(body.conversationId);
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 10).map((item) => {
      const row = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return { catalogId: whole(row.catalogId), qty: whole(row.qty) };
    });
    if (!(conversationId > 0) || items.length === 0 || items.some((item) => !(item.catalogId > 0) || !(item.qty > 0))) {
      return safeJson({ error: { code: "bad_request", message: "Pick at least one product and quantity." } }, 400);
    }
    const discount = typeof body.discountPercent === "number" ? body.discountPercent : 0;
    const days = whole(body.expiresInDays);
    return serviceResponse(
      await createSalesQuote(accessToken, {
        conversationId,
        items,
        discountPercent: discount,
        expiresInDays: days > 0 ? days : null,
        title: typeof body.title === "string" ? body.title.slice(0, 80) : "",
      })
    );
  }, request);
}
