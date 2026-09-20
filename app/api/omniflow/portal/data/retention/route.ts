import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getRetention,
  requirePortalAccessToken,
  saveRetention,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
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
    const retention = await getRetention(accessToken);
    if (retention === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ retention }, 200);
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
  const clamp = (value: unknown, fallback: number) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 1 && num <= 90
      ? Math.floor(num)
      : fallback;
  };
  const closeIdle = clamp(input.close_idle_days, 14);
  const purgeRejected = clamp(input.purge_rejected_days, 30);

  try {
    const retention = await saveRetention(accessToken, closeIdle, purgeRejected);
    if (retention === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, retention }, 200);
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
