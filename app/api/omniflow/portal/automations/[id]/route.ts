import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteAutomation,
  requirePortalAccessToken,
  setAutomationActive,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveRuleId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) return null;
  return ruleId;
}

export async function PATCH(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const ruleId = await resolveRuleId(context);
  if (ruleId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid automation id." } },
      400
    );
  }
  const payload = (await request.json().catch(() => null)) as {
    isActive?: unknown;
  } | null;
  if (typeof payload?.isActive !== "boolean") {
    return safeJson(
      { error: { code: "bad_request", message: "isActive must be true or false." } },
      400
    );
  }

  try {
    const result = await setAutomationActive(accessToken, ruleId, payload.isActive);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "missing") {
      return safeJson(
        { error: { code: "not_found", message: "Automation not found." } },
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

export async function DELETE(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const ruleId = await resolveRuleId(context);
  if (ruleId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid automation id." } },
      400
    );
  }

  try {
    const result = await deleteAutomation(accessToken, ruleId);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "missing") {
      return safeJson(
        { error: { code: "not_found", message: "Automation not found." } },
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
