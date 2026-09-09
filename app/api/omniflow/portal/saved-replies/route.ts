import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createSavedReply,
  listSavedReplies,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

function normalizeShortcut(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .slice(0, 24);
}

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listSavedReplies(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ replies: data }, 200);
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
    shortcut?: unknown;
    body?: unknown;
  } | null;
  const shortcut = normalizeShortcut(payload?.shortcut);
  if (!/^[a-z0-9_-]{1,24}$/.test(shortcut)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message:
            "Shortcut can use letters, numbers, dashes and underscores (max 24).",
        },
      },
      400
    );
  }
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text is required." } },
      400
    );
  }
  if (body.length > 1000) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Message must be 1000 characters or fewer.",
        },
      },
      400
    );
  }

  try {
    const result = await createSavedReply(accessToken, shortcut, body);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Invalid saved reply — check the shortcut and message.",
          },
        },
        400
      );
    }
    if (result.kind === "duplicate") {
      return safeJson(
        {
          error: {
            code: "duplicate",
            message: "A reply with this shortcut already exists.",
          },
        },
        409
      );
    }
    if (result.kind === "limit_reached") {
      return safeJson(
        {
          error: {
            code: "limit_reached",
            message: "Up to 30 saved replies per workspace.",
          },
        },
        409
      );
    }
    return safeJson({ ok: true, reply: result.reply }, 200);
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
