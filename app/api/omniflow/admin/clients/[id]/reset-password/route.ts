import { createClient } from "../../../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import { resetAdminPassword } from "../../../../../../../lib/omniflow/admin-control-plane";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";


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

  try {
    const result = await resetAdminPassword(userId);
    return safeJson(result);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError) {
      if (error.code === "service_not_configured") {
        return safeJson(
          {
            error: {
              code: "service_not_configured",
              message:
                "Admin bridge not configured — set OMNIFLOW_SERVICE_KEY on the website project.",
            },
          },
          503
        );
      }
      if (error.status === 404) {
        return safeJson(
          { error: { code: "user_not_found", message: "No such client." } },
          404
        );
      }
      if (error.status === 403) {
        return safeJson(
          {
            error: {
              code: "forbidden",
              message: "Service key rejected by the Control Plane.",
            },
          },
          503
        );
      }
    }
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
