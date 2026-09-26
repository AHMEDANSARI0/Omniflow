import {
  orderFromStore,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";


export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const { slug } = await context.params;
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
  if (!clean) {
    return safeJson(
      { error: { code: "not_found", message: "Store not found." } },
      404
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const phone = String(body.phone || "").trim().slice(0, 20);
  const name = String(body.name || "").trim().slice(0, 80);
  const itemId = Number(body.item_id || 0);
  if (!phone) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Enter your WhatsApp number.",
        },
      },
      400
    );
  }
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick an item first." } },
      400
    );
  }
  const result = await orderFromStore(clean, phone, name, itemId);
  if (result === "not_found") {
    return safeJson(
      { error: { code: "not_found", message: "Store or item not found." } },
      404
    );
  }
  if (result === "bad_request") {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Enter a valid WhatsApp number, e.g. 923001234567.",
        },
      },
      400
    );
  }
  if (result === "rate_limited") {
    return safeJson(
      {
        error: {
          code: "rate_limited",
          message: "Too many orders — try again shortly.",
        },
      },
      429
    );
  }
  if (result === null) {
    return safeJson(
      {
        error: {
          code: "order_unavailable",
          message: "Could not place the order — try again shortly.",
        },
      },
      503
    );
  }
  return safeJson(result, 200);
}
