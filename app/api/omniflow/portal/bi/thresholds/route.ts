import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  getBiThresholds,
  requirePortalAccessToken,
  saveBiThresholds,
  type BiThresholds,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = {
  error: { code: "portal_unavailable", message: "Try again shortly." },
};

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);

  try {
    const payload = await getBiThresholds(accessToken);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(
      {
        thresholds: payload.thresholds,
        defaults: payload.defaults,
        timezone_offset_hours: payload.timezoneOffsetHours,
        keys: payload.keys,
      },
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
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);

  const body = (await request.json().catch(() => null)) as {
    thresholds?: unknown;
  } | null;
  const raw =
    body && body.thresholds !== null && typeof body.thresholds === "object"
      ? (body.thresholds as Record<string, unknown>)
      : null;
  if (!raw) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "thresholds must be an object.",
        },
      },
      400
    );
  }
  const thresholds: BiThresholds = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      thresholds[key] = value;
    }
  }

  try {
    const result = await saveBiThresholds(accessToken, thresholds);
    if (result === null) return safeJson(DOWN, 503);
    if (result.kind === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: result.message } },
        400
      );
    }
    return safeJson({ ok: true, thresholds: result.thresholds }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
