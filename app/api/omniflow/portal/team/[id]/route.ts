import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  removeTeamMember,
  requirePortalAccessToken,
  updateTeamMember,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveMemberId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const memberId = Number(id);
  if (!Number.isInteger(memberId) || memberId <= 0) return null;
  return memberId;
}

function mapMutationResult(result: {
  kind: string;
  member?: unknown;
}): { status: number; body: unknown } {
  if (result.kind === "ok") {
    return { status: 200, body: { ok: true, member: result.member ?? null } };
  }
  if (result.kind === "forbidden") {
    return {
      status: 403,
      body: {
        error: {
          code: "forbidden_role",
          message: "Only the owner or an admin can manage the team.",
        },
      },
    };
  }
  if (result.kind === "exists") {
    return {
      status: 409,
      body: {
        error: { code: "email_exists", message: "This email is already on the team." },
      },
    };
  }
  if (result.kind === "not_found") {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "Team member not found." } },
    };
  }
  return {
    status: 503,
    body: { error: { code: "portal_unavailable", message: "Try again shortly." } },
  };
}

export async function PATCH(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const memberId = await resolveMemberId(context);
  if (memberId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid member id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    role?: unknown;
    status?: unknown;
  } | null;
  const patch: { role?: string; status?: string } = {};
  if (payload?.role === "admin" || payload?.role === "agent") {
    patch.role = payload.role;
  }
  if (payload?.status === "active" || payload?.status === "disabled") {
    patch.status = payload.status;
  }
  if (Object.keys(patch).length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }

  try {
    const result = await updateTeamMember(accessToken, memberId, patch);
    const mapped = mapMutationResult(result);
    return safeJson(mapped.body, mapped.status);
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
  const memberId = await resolveMemberId(context);
  if (memberId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid member id." } },
      400
    );
  }

  try {
    const result = await removeTeamMember(accessToken, memberId);
    const mapped = mapMutationResult(result);
    return safeJson(mapped.body, mapped.status);
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
