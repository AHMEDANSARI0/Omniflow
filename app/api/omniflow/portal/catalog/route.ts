import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createCatalogItem,
  getCatalog,
  requirePortalAccessToken,
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
    const data = await getCatalog(accessToken);
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

function parseItemInput(payload: {
  item?: {
    kind?: unknown;
    name?: unknown;
    priceText?: unknown;
    notes?: unknown;
    isActive?: unknown;
  };
} | null):
  | { kind: "ok"; item: { kind: "product" | "service"; name: string; priceText: string; notes: string; isActive: boolean } }
  | { kind: "error"; message: string } {
  const input = payload?.item;
  if (!input) {
    return { kind: "error", message: "item object is required." };
  }
  const kind = input.kind === "service" ? "service" : "product";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const priceText = typeof input.priceText === "string" ? input.priceText.trim() : "";
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const isActive = input.isActive !== false;
  if (!name || name.length > 200) {
    return { kind: "error", message: "Name is required (max 200 characters)." };
  }
  if (priceText.length > 100) {
    return { kind: "error", message: "Price must be 100 characters or fewer." };
  }
  if (notes.length > 1000) {
    return { kind: "error", message: "Notes must be 1000 characters or fewer." };
  }
  return { kind: "ok", item: { kind, name, priceText, notes, isActive } };
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as Parameters<
    typeof parseItemInput
  >[0];
  const parsed = parseItemInput(payload);
  if (parsed.kind === "error") {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const ok = await createCatalogItem(accessToken, parsed.item);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
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
