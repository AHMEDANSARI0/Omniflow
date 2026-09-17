import {
  createCheckoutLink,
  listCheckoutLinks,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const links = await listCheckoutLinks(accessToken);
    if (links === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ links }, 200);
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


export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const contactId = String(body.contact_id || "").trim();
  const title = String(body.title || "").trim();
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!contactId || contactId.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id is required." } },
      400
    );
  }
  if (rawItems.length === 0 || rawItems.length > 20) {
    return safeJson(
      { error: { code: "bad_request", message: "1-20 items are required." } },
      400
    );
  }
  const items: { name: string; qty: number; price: number }[] = [];
  for (const entry of rawItems) {
    if (entry === null || typeof entry !== "object") {
      return safeJson(
        { error: { code: "bad_request", message: "Each item must be an object." } },
        400
      );
    }
    const row = entry as Record<string, unknown>;
    const name = String(row.name || "").trim();
    const qty = Number(row.qty ?? 1);
    const price = Number(row.price ?? 0);
    if (!name || !Number.isFinite(qty) || qty < 1 || qty > 99 ||
        !Number.isFinite(price) || price < 0) {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Every item needs a name, qty 1-99 and price 0+.",
          },
        },
        400
      );
    }
    items.push({ name, qty: Math.round(qty), price });
  }

  const rawExpiry = body.expires_in_days;
  let expiresInDays: number | null = null;
  if (rawExpiry !== null && rawExpiry !== undefined && rawExpiry !== "") {
    const days = Number(rawExpiry);
    if (!Number.isInteger(days) || days < 1 || days > 60) {
      return safeJson(
        { error: { code: "bad_request", message: "Expiry must be 1-60 days." } },
        400
      );
    }
    expiresInDays = days;
  }

  let discountAmount: number | null = null;
  const rawDiscount = body.discount_amount;
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
    const link = await createCheckoutLink(
      accessToken,
      contactId,
      title,
      items,
      expiresInDays,
      discountAmount
    );
    if (link === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, link }, 200);
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
