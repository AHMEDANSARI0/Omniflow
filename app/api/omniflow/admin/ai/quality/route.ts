import { createClient } from "../../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import { getAdminAiQuality } from "../../../../../../lib/omniflow/admin-control-plane";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
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
  const params = new URL(request.url).searchParams;
  const daysRaw = Number.parseInt(params.get("days") ?? "7", 10);
  const days = [1, 7, 14, 30].includes(daysRaw) ? daysRaw : 7;
  const clientRaw = params.get("client_id");
  const clientId =
    clientRaw && Number.isFinite(Number(clientRaw)) && Number(clientRaw) > 0
      ? Number(clientRaw)
      : undefined;

  try {
    const payload = await getAdminAiQuality(days, clientId);
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
    }
    return safeJson(
      {
        error: {
          code: "ai_quality_unavailable",
          message: "Could not sample live AI quality. Please try again.",
        },
      },
      503
    );
  }
}
