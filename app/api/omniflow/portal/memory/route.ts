import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  addCustomerMemory,
  listCustomerMemory,
  purgeCustomerMemory,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

const KINDS = ["preference", "note", "fact"];
const MTYPES = ["short", "long", "business", "journey"];
const MAX_EXPIRY_HOURS = 8760;

function contactFrom(request: Request): string {
  return (new URL(request.url).searchParams.get("contact") ?? "").trim();
}

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const contact = contactFrom(request);
  if (!contact) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }

  try {
    const payload = await listCustomerMemory(accessToken, contact);
    if (payload === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(payload, 200);
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
    contact?: unknown;
    kind?: unknown;
    content?: unknown;
    mtype?: unknown;
    expires_hours?: unknown;
  } | null;
  const contact =
    payload && typeof payload.contact === "string"
      ? payload.contact.trim()
      : "";
  const kind =
    payload && typeof payload.kind === "string" && KINDS.includes(payload.kind)
      ? payload.kind
      : "note";
  const mtype =
    payload && typeof payload.mtype === "string" &&
    MTYPES.includes(payload.mtype)
      ? payload.mtype
      : "long";
  const rawHours =
    payload && typeof payload.expires_hours === "number"
      ? payload.expires_hours
      : 0;
  if (!Number.isFinite(rawHours) || rawHours < 0 ||
      rawHours > MAX_EXPIRY_HOURS) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "expires_hours must be between 0 and " +
            MAX_EXPIRY_HOURS + ".",
        },
      },
      400
    );
  }
  const content =
    payload && typeof payload.content === "string"
      ? payload.content.trim()
      : "";
  if (!contact || !content) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "contact and content are required.",
        },
      },
      400
    );
  }

  try {
    const ok = await addCustomerMemory(
      accessToken,
      contact,
      kind as "preference" | "note" | "fact",
      content,
      mtype as "short" | "long" | "business" | "journey",
      Math.round(rawHours)
    );
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

export async function DELETE(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const contact = contactFrom(request);
  if (!contact) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }

  try {
    const ok = await purgeCustomerMemory(accessToken, contact);
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
