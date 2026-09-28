import { createClient } from "../../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import { getAdminAiOverview } from "../../../../../../lib/omniflow/admin-control-plane";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";


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
  const url = new URL(request.url);
  const days = Number.parseInt(url.searchParams.get("days") ?? "7", 10);

  try {
    const payload = await getAdminAiOverview(Number.isFinite(days) ? days : 7);
    return safeJson(payload, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError) {
      if (
        error.code === "service_not_configured" ||
        error.code === "control_plane_not_configured"
      ) {
        return safeJson(
          {
            error: {
              code: "service_not_configured",
              message:
                "Admin bridge not configured — set OMNIFLOW_SERVICE_KEY and OMNIFLOW_CONTROL_PLANE_URL on the website project.",
            },
          },
          503
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
          code: "ai_overview_unavailable",
          message: "Could not load the AI overview. Please try again.",
        },
      },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
