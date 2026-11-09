import { createClient } from "../../../../../../../lib/supabase/server";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";
import { writeSessionCookies } from "../../../../../../../lib/omniflow/session-cookies";
import { createAdminImpersonationSession } from "../../../../../../lib/workspace-store";

async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
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
  const targetId = Number(id);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Invalid workspace ID." } }, 400);
  }

  const tokens = await createAdminImpersonationSession(targetId);
  if (!tokens) {
    return safeJson({ error: { code: "not_found", message: "Workspace not found." } }, 404);
  }

  await writeSessionCookies(tokens);
  return safeJson({
    ok: true,
    client_id: tokens.clientId,
    user_id: tokens.userId,
    redirect: "/dashboard",
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
