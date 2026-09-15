import {
  requirePortalAccessToken,
  setContactStage,
  type PipelineStage,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";

const STAGE_VALUES: PipelineStage[] = [
  "new",
  "interested",
  "negotiating",
  "won",
  "lost",
];


export async function POST(request: Request) {
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
  const contact = typeof input.contact === "string" ? input.contact.trim() : "";
  const stage = input.stage;
  if (!contact || contact.length > 100) {
    return safeJson(
      { error: { code: "bad_request", message: "contact is required." } },
      400
    );
  }
  if (
    typeof stage !== "string" ||
    !STAGE_VALUES.includes(stage as PipelineStage)
  ) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick a valid stage." } },
      400
    );
  }

  try {
    const result = await setContactStage(
      accessToken,
      contact,
      stage as PipelineStage
    );
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Pick a valid stage." } },
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
