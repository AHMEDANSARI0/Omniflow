import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  importOrders,
  listOrders,
  requirePortalAccessToken,
  type OrderImportItem,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listOrders(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    items?: unknown;
  } | null;
  if (!Array.isArray(payload?.items) || payload.items.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Paste at least one order." } },
      400
    );
  }
  if (payload.items.length > 500) {
    return safeJson(
      { error: { code: "bad_request", message: "Import at most 500 orders at a time." } },
      400
    );
  }
  const items: OrderImportItem[] = [];
  for (const raw of payload.items) {
    const item = raw as { code?: unknown; status?: unknown; note?: unknown };
    const code = typeof item.code === "string" ? item.code.trim().toUpperCase() : "";
    if (!code || code.length > 40) {
      return safeJson(
        { error: { code: "bad_request", message: "Every order needs a code (max 40 characters)." } },
        400
      );
    }
    items.push({
      code,
      status: typeof item.status === "string" ? item.status.trim().slice(0, 60) : "pending",
      note: typeof item.note === "string" ? item.note.trim().slice(0, 200) : "",
    });
  }

  try {
    const ok = await importOrders(accessToken, items);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, imported: items.length }, 200);
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
