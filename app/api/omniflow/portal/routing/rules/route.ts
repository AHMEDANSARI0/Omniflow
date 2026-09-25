import {
  addRoutingRule,
  deleteRoutingRule,
  listRoutingRules,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
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
    const rules = await listRoutingRules(accessToken);
    if (rules === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ rules }, 200);
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
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const match = String(body.match || "").trim();
  const userId = Number(body.user_id);
  const priority = Number(body.priority ?? 100);
  if (!match || match.length > 60) {
    return safeJson(
      { error: { code: "bad_request", message: "match (max 60 chars) is required." } },
      400
    );
  }
  if (!Number.isFinite(userId) || userId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "user_id is required." } },
      400
    );
  }
  if (!Number.isFinite(priority) || priority < 1 || priority > 999) {
    return safeJson(
      { error: { code: "bad_request", message: "priority must be 1-999." } },
      400
    );
  }

  try {
    const rule = await addRoutingRule(
      accessToken,
      match,
      Math.round(userId),
      Math.round(priority)
    );
    if (rule === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, id: rule.id }, 200);
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


export async function DELETE(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const params = new URL(request.url).searchParams;
  const ruleId = Number.parseInt(params.get("id") || "", 10);
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }

  try {
    const removed = await deleteRoutingRule(accessToken, ruleId);
    if (removed === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (removed === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Rule not found." } },
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
