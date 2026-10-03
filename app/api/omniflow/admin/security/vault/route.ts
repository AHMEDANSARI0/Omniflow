import { createClient } from "../../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import { getAdminVault } from "../../../../../../lib/omniflow/admin-control-plane";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return safeJson({ error: { code: "unauthorized", message: "Admin sign in required." } }, 401);
  }
  try {
    return safeJson(await getAdminVault(), 200);
  } catch (failure) {
    if (failure instanceof ControlPlaneRequestError) {
      if (failure.code === "service_not_configured" || failure.code === "control_plane_not_configured") {
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
      if (failure.status === 403) {
        return safeJson(
          { error: { code: "forbidden", message: "Service key rejected by the Control Plane." } },
          503
        );
      }
    }
    return safeJson(
      { error: { code: "vault_unavailable", message: "Could not read the encryption status. Please try again." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
