import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getCheckoutNotifySettings,
  requirePortalAccessToken,
  saveCheckoutNotifySettings,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getCheckoutNotifySettings(accessToken);
    if (settings === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Order updates are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ ok: true, settings }, 200);
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

export async function PUT(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const raw =
    input.settings !== null && typeof input.settings === "object"
      ? (input.settings as Record<string, unknown>)
      : {};
  const settings = {
    notifyEnabled: raw.notify_enabled === true,
    tplPaid: typeof raw.tpl_paid === "string" ? raw.tpl_paid.trim().slice(0, 500) : "",
    tplShipped: typeof raw.tpl_shipped === "string" ? raw.tpl_shipped.trim().slice(0, 500) : "",
    tplDelivered: typeof raw.tpl_delivered === "string" ? raw.tpl_delivered.trim().slice(0, 500) : "",
    tplReturned: typeof raw.tpl_returned === "string" ? raw.tpl_returned.trim().slice(0, 500) : "",
    cartEnabled: false,
    cartGap1: 2,
    cartGap2: 24,
    cartGap3: 48,
    cartTpl1: "",
    cartTpl2: "",
    cartTpl3: "",
  };
  if (typeof raw.notify_enabled !== "boolean") {
    return safeJson(
      { error: { code: "bad_request", message: "notify_enabled must be true or false." } },
      400
    );
  }
  const cartRaw =
    raw.cart !== null && typeof raw.cart === "object"
      ? (raw.cart as Record<string, unknown>)
      : null;
  if (cartRaw) {
    settings.cartEnabled = cartRaw.enabled === true;
    const gaps: [number, unknown, number][] = [
      [1, cartRaw.gap_1, 2],
      [2, cartRaw.gap_2, 24],
      [3, cartRaw.gap_3, 48],
    ];
    for (const [slot, value, fallback] of gaps) {
      if (
        typeof value !== "number"
        || !Number.isFinite(value)
        || value < 1
        || value > 168
      ) {
        if (value !== undefined && value !== null && value !== "") {
          return safeJson(
            { error: { code: "bad_request", message: "Reminder gaps are 1 to 168 hours." } },
            400
          );
        }
        if (slot === 1) settings.cartGap1 = fallback;
        if (slot === 2) settings.cartGap2 = fallback;
        if (slot === 3) settings.cartGap3 = fallback;
      } else {
        if (slot === 1) settings.cartGap1 = Math.floor(value);
        if (slot === 2) settings.cartGap2 = Math.floor(value);
        if (slot === 3) settings.cartGap3 = Math.floor(value);
      }
    }
    settings.cartTpl1 =
      typeof cartRaw.tpl_1 === "string" ? cartRaw.tpl_1.trim().slice(0, 500) : "";
    settings.cartTpl2 =
      typeof cartRaw.tpl_2 === "string" ? cartRaw.tpl_2.trim().slice(0, 500) : "";
    settings.cartTpl3 =
      typeof cartRaw.tpl_3 === "string" ? cartRaw.tpl_3.trim().slice(0, 500) : "";
  }

  try {
    const result = await saveCheckoutNotifySettings(accessToken, settings);
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Templates are capped at 500 characters." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, settings }, 200);
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
