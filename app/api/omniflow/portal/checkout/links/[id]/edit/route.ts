import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";
import {
  editCheckoutLink,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../../lib/omniflow/request-security";

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}


export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const linkId = parseId(id);
  if (linkId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid link id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = rawItems
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object")
    .map((entry) => ({
      name:
        typeof entry.name === "string" ? entry.name.trim().slice(0, 80) : "",
      qty: typeof entry.qty === "number" && entry.qty >= 1 && entry.qty <= 1000
        ? Math.floor(entry.qty)
        : 0,
      price: typeof entry.price === "number"
          && Number.isFinite(entry.price)
          && entry.price >= 0
        ? Math.round(entry.price * 100) / 100
        : -1,
    }))
    .filter((item) => item.name && item.qty >= 1 && item.price >= 0);
  if (!items.length) {
    return safeJson(
      { error: { code: "bad_request", message: "At least one valid item is required." } },
      400
    );
  }

  let expiresInDays: number | null = null;
  const rawExpiry = input.expires_in_days;
  if (rawExpiry !== null && rawExpiry !== undefined && rawExpiry !== "") {
    const days = Number(rawExpiry);
    if (!Number.isInteger(days) || days < 0 || days > 60) {
      return safeJson(
        { error: { code: "bad_request", message: "Expiry must be 0-60 days." } },
        400
      );
    }
    expiresInDays = days;
  }

  let discountAmount: number | null = null;
  const rawDiscount = input.discount_amount;
  if (rawDiscount !== null && rawDiscount !== undefined && rawDiscount !== "") {
    const amount = Number(rawDiscount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
      return safeJson(
        { error: { code: "bad_request", message: "Discount must be 0-100000." } },
        400
      );
    }
    discountAmount = Math.round(amount * 100) / 100;
  }

  try {
    const result = await editCheckoutLink(
      accessToken,
      linkId,
      title,
      items,
      expiresInDays,
      discountAmount
    );
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Only open links can be edited." } },
        404
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Items are invalid." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, total: result.total }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
