import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createAutomation,
  listAutomations,
  requirePortalAccessToken,
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
    const data = await listAutomations(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ automations: data }, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    keyword?: unknown;
    actionType?: unknown;
    actionValue?: unknown;
  } | null;
  const keyword = typeof payload?.keyword === "string" ? payload.keyword : "";
  const actionType =
    payload?.actionType === "add_tag" || payload?.actionType === "assign"
      ? payload.actionType
      : "";
  const actionValue =
    typeof payload?.actionValue === "string" ? payload.actionValue : "";
  if (!keyword.trim() || !actionType || !actionValue.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Keyword, action and value are required." } },
      400
    );
  }

  try {
    const result = await createAutomation(
      accessToken,
      keyword,
      actionType,
      actionValue
    );
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Keyword must be 2-40 characters; check the value too.",
          },
        },
        400
      );
    }
    if (result.kind === "assignee_not_found") {
      return safeJson(
        {
          error: {
            code: "assignee_not_found",
            message: "Assignee must be an active team member.",
          },
        },
        400
      );
    }
    if (result.kind === "duplicate") {
      return safeJson(
        {
          error: {
            code: "duplicate",
            message: "A rule with this keyword and action already exists.",
          },
        },
        409
      );
    }
    if (result.kind === "limit_reached") {
      return safeJson(
        {
          error: { code: "limit_reached", message: "Up to 20 automations." },
        },
        409
      );
    }
    return safeJson({ ok: true, automation: result.automation }, 200);
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
