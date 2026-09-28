import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  archiveAgent,
  requirePortalAccessToken,
  updateAgent,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { parseAgentPermissions } from "../../../../../../lib/omniflow/agent-permissions";

const MAX_NAME = 60;
const MAX_TONE = 120;
const MAX_INSTRUCTIONS = 1000;

async function idFrom(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  return Number.parseInt(id ?? "", 10);
}

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
  const agentId = await idFrom(params);
  if (!Number.isFinite(agentId) || agentId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    name?: unknown;
    tone?: unknown;
    instructions?: unknown;
    escalation_user_id?: unknown;
    is_active?: unknown;
    allowed_actions?: unknown;
    max_risk?: unknown;
    can_auto_reply?: unknown;
  } | null;
  const permissions = parseAgentPermissions(payload);
  if (!permissions.ok) {
    return safeJson(
      { error: { code: "bad_request", message: permissions.message } },
      400
    );
  }
  const name =
    payload && typeof payload.name === "string" ? payload.name.trim() : "";
  const tone =
    payload && typeof payload.tone === "string" ? payload.tone.trim() : "";
  const instructions =
    payload && typeof payload.instructions === "string"
      ? payload.instructions.trim()
      : "";
  const rawEscalation =
    payload && typeof payload.escalation_user_id === "number"
      ? payload.escalation_user_id
      : null;
  const isActive = payload?.is_active !== false;
  if (!name || name.length > MAX_NAME) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "name (max " + MAX_NAME + " chars) is required.",
        },
      },
      400
    );
  }
  if (tone.length > MAX_TONE || instructions.length > MAX_INSTRUCTIONS) {
    return safeJson(
      { error: { code: "bad_request", message: "text is too long." } },
      400
    );
  }
  let escalationUserId: number | null = null;
  if (rawEscalation !== null) {
    if (!Number.isFinite(rawEscalation) || rawEscalation <= 0) {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "escalation_user_id must be a positive integer.",
          },
        },
        400
      );
    }
    escalationUserId = Math.round(rawEscalation);
  }

  try {
    const result = await updateAgent(accessToken, agentId, {
      name,
      tone,
      instructions,
      escalationUserId,
      isActive,
      ...permissions.value,
    });
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "No such agent." } },
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

export async function DELETE(
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
  const agentId = await idFrom(params);
  if (!Number.isFinite(agentId) || agentId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }

  try {
    const result = await archiveAgent(accessToken, agentId);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "No such agent." } },
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
