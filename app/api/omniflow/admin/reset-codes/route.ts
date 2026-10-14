import { createClient } from "../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import { listRecentResetCodes } from "../../../../../lib/omniflow/admin-control-plane";
import { adminBridgeError } from "../../../../../lib/omniflow/admin-bridge-error";
import {
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
    const codes = await listRecentResetCodes();
    return safeJson({ codes });
  } catch (error) {
    const bridge = adminBridgeError(error);
    if (bridge) return bridge;
    if (error instanceof ControlPlaneRequestError) {
      if (error.status === 404) {
        // Older control-plane deployment without the codes endpoint —
        // treat as "no codes" so the panel simply stays hidden.
        return safeJson({ codes: [] });
      }
    }
    return safeJson(
      {
        error: {
          code: "codes_unavailable",
          message: "Could not load reset codes. Please try again.",
        },
      },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
