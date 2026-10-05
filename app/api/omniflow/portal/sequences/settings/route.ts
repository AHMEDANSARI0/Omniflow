import {
  getSequenceSettings,
  requirePortalAccessToken,
  saveSequenceSettings,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const settings = await getSequenceSettings(accessToken);
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
  // §236: the PUT changes the send window and spacing - same-origin only
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Cross-site request blocked." } }, 403);
  }
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
  const quietEnabled = input.quietEnabled === true;
  const quietStart = Number(input.quietStart);
  const quietEnd = Number(input.quietEnd);
  const utcOffset = Number(input.utcOffset);
  // §236: optional gap between follow-ups of different series (hours)
  let gapHours: number | null | undefined;
  if ("gapHours" in input) {
    gapHours = input.gapHours === null ? null : Number(input.gapHours);
    if (gapHours !== null && (!Number.isInteger(gapHours) || gapHours < 0 || gapHours > 168)) {
      return safeJson(
        { error: { code: "bad_request", message: "The gap must be 0 to 168 hours." } },
        400
      );
    }
  }
  if (
    !Number.isInteger(quietStart) ||
    quietStart < 0 ||
    quietStart > 23 ||
    !Number.isInteger(quietEnd) ||
    quietEnd < 0 ||
    quietEnd > 23 ||
    !Number.isInteger(utcOffset) ||
    utcOffset < -12 ||
    utcOffset > 14
  ) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid send-window values." } },
      400
    );
  }

  try {
    const result = await saveSequenceSettings(accessToken, {
      quietEnabled,
      quietStart,
      quietEnd,
      utcOffset,
      ...(gapHours !== undefined ? { gapHours } : {}),
    });
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Invalid send-window values." } },
        400
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
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
