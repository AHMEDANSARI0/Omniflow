import { createClient } from "../../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import { getAdminModelRouter } from "../../../../../../lib/omniflow/admin-control-plane";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";

// Model Router (§229) overview: routes, providers, breaker, usage.
async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  if (!(await requireAdminSession())) {
    return safeJson({ error: { code: "unauthorized", message: "Admin sign in required." } }, 401);
  }
  const days = Number.parseInt(new URL(request.url).searchParams.get("days") ?? "7", 10);
  try {
    return safeJson(await getAdminModelRouter(Number.isFinite(days) ? days : 7), 200);
  } catch (error) {
    if (
      error instanceof ControlPlaneRequestError &&
      (error.code === "service_not_configured" || error.code === "control_plane_not_configured")
    ) {
      return safeJson(
        {
          error: {
            code: "service_not_configured",
            message:
              "Admin bridge not configured - set OMNIFLOW_SERVICE_KEY and OMNIFLOW_CONTROL_PLANE_URL on the website project.",
          },
        },
        503
      );
    }
    if (error instanceof ControlPlaneRequestError && error.status === 404) {
      return safeJson(
        {
          error: {
            code: "router_unavailable",
            message: "The Control Plane does not have the Model Router yet - run batch 229 there.",
          },
        },
        503
      );
    }
    return safeJson(
      { error: { code: "router_unavailable", message: "Could not load the Model Router. Please try again." } },
      503
    );
  }
}
