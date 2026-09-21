import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  putRecoverySettings,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function PUT(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    auto_enabled?: unknown;
    checkout_hours?: unknown;
    cod_hours?: unknown;
    inactive_days?: unknown;
    min_value?: unknown;
  } | null;
  if (!payload || typeof payload.auto_enabled !== "boolean") {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "auto_enabled (boolean) is required.",
        },
      },
      400
    );
  }

  try {
    const ok = await putRecoverySettings(accessToken, {
      auto_enabled: payload.auto_enabled,
      checkout_hours:
        typeof payload.checkout_hours === "number"
          ? payload.checkout_hours
          : 24,
      cod_hours:
        typeof payload.cod_hours === "number" ? payload.cod_hours : 12,
      inactive_days:
        typeof payload.inactive_days === "number"
          ? payload.inactive_days
          : 21,
      min_value:
        typeof payload.min_value === "number" ? payload.min_value : 5000,
    });
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
