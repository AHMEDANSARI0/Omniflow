import { safeJson } from "../../../../../lib/omniflow/request-security";
import { widgetControlPlaneFetch } from "../../../../../lib/omniflow/widget-transport";

const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const visitorId = url.searchParams.get("visitor_id") ?? "";
  const since = url.searchParams.get("since") ?? "0";
  if (!VISITOR_RE.test(visitorId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid visitor." } },
      400
    );
  }

  try {
    const response = await widgetControlPlaneFetch(
      "/api/v1/widget/chat?visitor_id=" +
        encodeURIComponent(visitorId) +
        "&since=" +
        encodeURIComponent(since.slice(0, 12))
    );
    if (!response) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (response.status === 403) {
      return safeJson(
        { error: { code: "widget_disabled", message: "Chat is not available." } },
        403
      );
    }
    if (!response.ok) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    const data = (await response.json().catch(() => null)) as unknown;
    if (data === null || typeof data !== "object") {
      return safeJson({ conversation_id: null, messages: [] }, 200);
    }
    return safeJson(data, 200);
  } catch {
    return safeJson(
      { error: { code: "widget_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    visitor_id?: unknown;
    text?: unknown;
  } | null;
  const visitorId =
    typeof payload?.visitor_id === "string" ? payload.visitor_id : "";
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!VISITOR_RE.test(visitorId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid visitor." } },
      400
    );
  }
  if (!text) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text is required." } },
      400
    );
  }
  if (text.length > 1000) {
    return safeJson(
      { error: { code: "bad_request", message: "Message too long." } },
      400
    );
  }

  try {
    const response = await widgetControlPlaneFetch("/api/v1/widget/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: visitorId, text }),
    });
    if (!response) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (response.status === 403) {
      return safeJson(
        { error: { code: "widget_disabled", message: "Chat is not available." } },
        403
      );
    }
    if (response.status === 429) {
      return safeJson(
        {
          error: {
            code: "rate_limited",
            message: "Too many messages — slow down a little.",
          },
        },
        429
      );
    }
    if (!response.ok) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    const data = (await response.json().catch(() => null)) as unknown;
    if (data === null || typeof data !== "object") {
      return safeJson({ ok: true, reply: null }, 200);
    }
    return safeJson(data, 200);
  } catch {
    return safeJson(
      { error: { code: "widget_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
