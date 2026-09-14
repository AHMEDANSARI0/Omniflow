import {
  requirePortalAccessToken,
  updateSequenceSteps,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  const steps = rawSteps
    .map((step) => {
      const item =
        step !== null && typeof step === "object"
          ? (step as { delay_hours?: unknown; body?: unknown })
          : {};
      return {
        delay_hours: typeof item.delay_hours === "number" ? item.delay_hours : 0,
        body: typeof item.body === "string" ? item.body : "",
      };
    })
    .filter((step) => step.body.trim().length > 0);
  if (steps.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "At least one step with text is required." } },
      400
    );
  }

  try {
    const result = await updateSequenceSteps(accessToken, sequenceId, steps);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Steps: 1 to 5, each with text and a 0-168h delay." } },
        400
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Sequence not found." } },
        404
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
