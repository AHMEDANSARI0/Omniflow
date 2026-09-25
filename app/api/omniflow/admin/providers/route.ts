import { createClient } from "../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getAdminProviders,
  putAdminProviders,
  type AdminProviderGroup,
} from "../../../../../lib/omniflow/admin-control-plane";
import {
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";


const GROUPS: AdminProviderGroup[] = [
  "email",
  "llm",
  "flags",
  "voice",
  "video",
  "payments",
  "whatsapp_e2e",
];

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
    const payload = await getAdminProviders();
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
                "Admin bridge not configured — set OMNIFLOW_SERVICE_KEY on the website project.",
            },
          },
          503
        );
      }
    }
    return safeJson(
      {
        error: {
          code: "providers_unavailable",
          message: "Could not load the integration settings. Please try again.",
        },
      },
      503
    );
  }
}

export async function PUT(request: Request) {
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
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const group = String(body.group || "");
  if (!GROUPS.includes(group as AdminProviderGroup)) {
    return safeJson(
      { error: { code: "bad_request", message: "Unknown settings group." } },
      400
    );
  }
  const rawValues = body.values;
  if (rawValues === null || typeof rawValues !== "object" ||
      Array.isArray(rawValues)) {
    return safeJson(
      { error: { code: "bad_request", message: "values object is required." } },
      400
    );
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    rawValues as Record<string, unknown>
  )) {
    if (typeof value !== "string") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Every value must be a string.",
          },
        },
        400
      );
    }
    values[key] = value;
  }
  try {
    const result = await putAdminProviders(
      group as AdminProviderGroup,
      values
    );
    return safeJson(result, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.status === 400) {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "The Control Plane rejected one of the values.",
          },
        },
        400
      );
    }
    return safeJson(
      {
        error: {
          code: "providers_unavailable",
          message: "Could not save the settings. Please try again.",
        },
      },
      503
    );
  }
}
