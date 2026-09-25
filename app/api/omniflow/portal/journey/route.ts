import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getJourney,
  moveJourneyStage,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const contact = (
    new URL(request.url).searchParams.get("contact") ?? ""
  ).trim();

  try {
    const payload = await getJourney(accessToken, contact);
    if (payload === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(payload, 200);
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
    contact?: unknown;
    stage_id?: unknown;
  } | null;
  const contact =
    payload && typeof payload.contact === "string"
      ? payload.contact.trim()
      : "";
  const stageId =
    payload && typeof payload.stage_id === "number" &&
    Number.isInteger(payload.stage_id) && payload.stage_id > 0
      ? payload.stage_id
      : 0;
  if (!contact || !stageId) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "contact and stage_id are required.",
        },
      },
      400
    );
  }

  try {
    const ok = await moveJourneyStage(accessToken, contact, stageId);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "No such stage." } },
        404
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
