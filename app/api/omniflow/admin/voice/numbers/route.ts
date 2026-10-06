import { createClient } from "../../../../../../lib/supabase/server";
import {
  assignAdminVoiceNumber,
  listAdminVoiceNumbers,
} from "../../../../../../lib/omniflow/admin-control-plane";
import { adminBridgeError } from "../../../../../../lib/omniflow/admin-bridge-error";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

/** Admin: which Twilio number answers for which workspace (D5). */
async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

function unavailable() {
  return safeJson(
    {
      error: {
        code: "voice_numbers_unavailable",
        message: "Could not reach the Control Plane. Please try again.",
      },
    },
    503
  );
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  if (!(await requireAdminSession())) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }
  try {
    const numbers = await listAdminVoiceNumbers();
    return numbers === null ? unavailable() : safeJson({ numbers }, 200);
  } catch (error) {
    const bridge = adminBridgeError(error);
    if (bridge) return bridge;
    return unavailable();
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  if (!(await requireAdminSession())) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const clientId = Math.trunc(Number(body.client_id || 0));
  const number = String(body.number || "").trim().slice(0, 20);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Enter the workspace id." } },
      400
    );
  }
  if (number && !/^\+[1-9]\d{7,14}$/.test(number)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Use the full international format, e.g. +14155550100.",
        },
      },
      400
    );
  }
  try {
    const result = await assignAdminVoiceNumber(clientId, number);
    if (result.kind === "ok") {
      return safeJson(
        { ok: true, client_id: result.clientId, number: result.number },
        200
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: result.message } },
        result.status
      );
    }
    return unavailable();
  } catch (error) {
    const bridge = adminBridgeError(error);
    if (bridge) return bridge;
    return unavailable();
  }
}
