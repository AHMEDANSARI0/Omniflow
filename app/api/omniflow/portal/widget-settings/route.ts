import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getWidgetSettings,
  requirePortalAccessToken,
  saveWidgetSettings,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await getWidgetSettings(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ settings: data }, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    enabled?: unknown;
    businessName?: unknown;
    welcomeText?: unknown;
    accent?: unknown;
    position?: unknown;
    launcherLabel?: unknown;
  } | null;
  if (typeof payload?.enabled !== "boolean") {
    return safeJson(
      { error: { code: "bad_request", message: "enabled must be true or false." } },
      400
    );
  }
  const businessName =
    typeof payload.businessName === "string" ? payload.businessName.trim() : "";
  const welcomeText =
    typeof payload.welcomeText === "string" ? payload.welcomeText.trim() : "";
  if (businessName.length > 80) {
    return safeJson(
      { error: { code: "bad_request", message: "Business name must be 80 characters or fewer." } },
      400
    );
  }
  if (welcomeText.length > 200) {
    return safeJson(
      { error: { code: "bad_request", message: "Welcome text must be 200 characters or fewer." } },
      400
    );
  }
  const accent =
    typeof payload.accent === "string" ? payload.accent.trim().toLowerCase() : "";
  if (accent && !/^#[0-9a-f]{6}$/.test(accent)) {
    return safeJson(
      { error: { code: "bad_request", message: "Accent must be a hex colour like #22d3ee." } },
      400
    );
  }
  const rawPosition = typeof payload.position === "string" ? payload.position : "";
  const position = rawPosition === "left" ? "left" : "right";
  const launcherLabel =
    typeof payload.launcherLabel === "string"
      ? payload.launcherLabel.trim().slice(0, 24)
      : "";

  try {
    const ok = await saveWidgetSettings(accessToken, {
      enabled: payload.enabled,
      businessName,
      welcomeText,
      accent: accent || "#22d3ee",
      position,
      launcherLabel,
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
