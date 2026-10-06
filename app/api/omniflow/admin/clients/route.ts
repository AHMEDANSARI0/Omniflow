import { createClient } from "../../../../../lib/supabase/server";
import { listAdminUsers } from "../../../../../lib/omniflow/admin-control-plane";
import { adminBridgeError } from "../../../../../lib/omniflow/admin-bridge-error";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";


async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  return data.user;
}

export async function GET(request: Request) {
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

  try {
    const users = await listAdminUsers();
    return safeJson({ users });
  } catch (error) {
    const bridge = adminBridgeError(error);
    if (bridge) return bridge;
    return safeJson(
      {
        error: {
          code: "clients_unavailable",
          message: "Could not load clients. Please try again.",
        },
      },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
