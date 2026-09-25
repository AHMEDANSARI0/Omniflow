import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getBrainSettings,
  putBrainSettings,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

const AUTONOMY = ["off", "suggest", "auto"];

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getBrainSettings(accessToken);
    if (settings === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ settings }, 200);
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
    autonomy?: unknown;
    tone?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.autonomy !== "string" ||
    !AUTONOMY.includes(payload.autonomy)
  ) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "autonomy must be one of off|suggest|auto.",
        },
      },
      400
    );
  }
  if (payload.tone !== undefined && typeof payload.tone !== "string") {
    return safeJson(
      { error: { code: "bad_request", message: "tone must be a string." } },
      400
    );
  }

  try {
    const ok = await putBrainSettings(accessToken, {
      autonomy: payload.autonomy as "off" | "suggest" | "auto",
      tone: typeof payload.tone === "string" ? payload.tone : "",
    });
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(
      {
        settings: {
          autonomy: payload.autonomy,
          tone: typeof payload.tone === "string" ? payload.tone : "",
        },
      },
      200
    );
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
