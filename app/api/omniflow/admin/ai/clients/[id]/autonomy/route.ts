import { createClient } from "../../../../../../../../lib/supabase/server";
import {
  setAdminClientAutonomy,
  type AdminAutonomy,
} from "../../../../../../../../lib/omniflow/admin-control-plane";
import { adminBridgeError } from "../../../../../../../../lib/omniflow/admin-bridge-error";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../../../lib/omniflow/request-security";


const LEVELS: AdminAutonomy[] = ["off", "suggest", "auto"];

async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  return data.user;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const admin = await requireAdminSession();
  if (!admin) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }
  const { id } = await context.params;
  const clientId = Number.parseInt(id ?? "", 10);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "client id is required." } },
      400
    );
  }
  const body = (await request.json().catch(() => null)) as {
    autonomy?: unknown;
    reason?: unknown;
  } | null;
  const autonomy = typeof body?.autonomy === "string" ? body.autonomy : "";
  if (!LEVELS.includes(autonomy as AdminAutonomy)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "autonomy must be off, suggest or auto.",
        },
      },
      400
    );
  }
  const reason =
    typeof body?.reason === "string" ? body.reason.trim().slice(0, 200) : "";

  try {
    const result = await setAdminClientAutonomy(
      clientId,
      autonomy as AdminAutonomy,
      reason
    );
    return safeJson(result, 200);
  } catch (error) {
    const bridge = adminBridgeError(error);
    if (bridge) return bridge;
    return safeJson(
      {
        error: {
          code: "autonomy_update_failed",
          message: "Could not update the workspace autonomy. Please try again.",
        },
      },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
