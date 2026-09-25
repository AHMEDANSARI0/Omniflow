import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createSequence,
  listSequences,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const sequences = await listSequences(accessToken);
    if (sequences === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Sequences are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ sequences }, 200);
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
  const name = typeof input.name === "string" ? input.name : "";
  const steps = Array.isArray(input.steps)
    ? (input.steps as {
        delay_hours?: unknown;
        body?: unknown;
        only_if_idle_hours?: unknown;
      }[]).map((step) => ({
        delay_hours: typeof step.delay_hours === "number" ? step.delay_hours : 0,
        body: typeof step.body === "string" ? step.body : "",
        only_if_idle_hours:
          typeof step.only_if_idle_hours === "number"
            ? step.only_if_idle_hours
            : null,
      }))
    : [];
  if (!name || steps.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Name and at least one step are required." } },
      400
    );
  }
  const triggerKeyword =
    typeof input.trigger_keyword === "string" && input.trigger_keyword.trim()
      ? input.trigger_keyword.trim()
      : null;

  try {
    const result = await createSequence(accessToken, name, steps, triggerKeyword);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Steps: 1 to 5, each with text and a 0-168h delay.",
          },
        },
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
