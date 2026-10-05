import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getNotifications,
  putNotificationSettings,
  requirePortalAccessToken,
  type NotifySettings,
} from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = { error: { code: "portal_unavailable", message: "Try again shortly." } };

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  try {
    const payload = await getNotifications(accessToken, 1);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(
      { settings: payload.settings, kinds: payload.kinds, email_configured: payload.email_configured },
      200
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const payload = (await request.json().catch(() => null)) as Partial<NotifySettings> | null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return safeJson(
      { error: { code: "bad_request", message: "A JSON object is required." } },
      400
    );
  }
  const input: Partial<NotifySettings> = {};
  if (typeof payload.email_enabled === "boolean") input.email_enabled = payload.email_enabled;
  if (typeof payload.email_to === "string") input.email_to = payload.email_to.trim().slice(0, 200);
  if (payload.min_severity === "normal" || payload.min_severity === "high") {
    input.min_severity = payload.min_severity;
  }
  if (payload.kinds && typeof payload.kinds === "object" && !Array.isArray(payload.kinds)) {
    const kinds: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(payload.kinds)) {
      if (typeof value === "boolean") kinds[key.slice(0, 40)] = value;
    }
    input.kinds = kinds;
  }
  // §239 rate limits: whole numbers only (the Control Plane checks the range)
  for (const key of ["bell_per_hour", "email_per_hour", "email_per_day"] as const) {
    const value = payload[key];
    if (typeof value === "number" && Number.isInteger(value)) input[key] = value;
  }
  if (Object.keys(input).length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }
  try {
    const result = await putNotificationSettings(accessToken, input);
    if (result.kind === "unavailable") return safeJson(DOWN, 503);
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: result.code, message: result.message } },
        result.status
      );
    }
    return safeJson(result.data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
