import { createClient } from "../../../../../../../lib/supabase/server";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";
import { resetClientWorkspacePassword } from "../../../../../../lib/workspace-store";

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
  const userId = Number(id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid client id." } },
      400
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const customPassword =
    typeof body.password === "string" && body.password.trim().length >= 8
      ? body.password.trim()
      : undefined;

  try {
    const result = await resetClientWorkspacePassword(userId, customPassword);
    return safeJson(result);
  } catch {
    return safeJson(
      {
        error: {
          code: "reset_failed",
          message: "Reset failed. Please try again.",
        },
      },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
