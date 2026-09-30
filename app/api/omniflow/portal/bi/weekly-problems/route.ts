import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  getWeeklyProblemsSettings,
  requirePortalAccessToken,
  saveWeeklyProblemsSettings,
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
    const payload = await getWeeklyProblemsSettings(accessToken);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(
      {
        settings: {
          enabled: payload.settings.enabled,
          hour: payload.settings.hour,
          weekday: payload.settings.weekday,
          last_sent_date: payload.settings.lastSentDate,
        },
        weekdays: payload.weekdays,
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
    settings?: unknown;
  } | null;
  const raw =
    body && body.settings !== null && typeof body.settings === "object"
      ? (body.settings as Record<string, unknown>)
      : body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : null;
  if (!raw) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "settings must be an object.",
        },
      },
      400
    );
  }

  const settings = {
    enabled: raw.enabled === true,
    hour: typeof raw.hour === "number" ? raw.hour : 9,
    weekday: typeof raw.weekday === "number" ? raw.weekday : 1,
  };

  try {
    const result = await saveWeeklyProblemsSettings(accessToken, settings);
    if (result === null) return safeJson(DOWN, 503);
    if (result.kind === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: result.message } },
        400
      );
    }
    return safeJson(
      {
        ok: true,
        settings: {
          enabled: result.settings.enabled,
          hour: result.settings.hour,
          weekday: result.settings.weekday,
          last_sent_date: result.settings.lastSentDate,
        },
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
