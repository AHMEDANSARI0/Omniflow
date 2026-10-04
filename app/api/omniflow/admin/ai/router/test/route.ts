import { createClient } from "../../../../../../../lib/supabase/server";
import {
  testAdminModelRouter,
  type RouterTestTarget,
} from "../../../../../../../lib/omniflow/admin-control-plane";
import { safeJson, sameOrigin } from "../../../../../../../lib/omniflow/request-security";

// One tiny JSON call against a provider or tier (§229). The provider may
// take a while, so the route gets more time than the default.
export const maxDuration = 30;

const TARGETS: RouterTestTarget[] = ["primary", "secondary", "fast", "smart"];

async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  if (!(await requireAdminSession())) {
    return safeJson({ error: { code: "unauthorized", message: "Admin sign in required." } }, 401);
  }
  const payload: unknown = await request.json().catch(() => null);
  const target = String(
    payload && typeof payload === "object" ? (payload as { target?: unknown }).target ?? "" : ""
  ) as RouterTestTarget;
  if (!TARGETS.includes(target)) {
    return safeJson({ error: { code: "bad_request", message: "Unknown test target." } }, 400);
  }
  try {
    const result = await testAdminModelRouter(target);
    if ("invalid" in result) {
      return safeJson({ error: { code: "not_configured", message: result.invalid } }, 409);
    }
    return safeJson(result, 200);
  } catch {
    return safeJson(
      { error: { code: "router_unavailable", message: "The test could not reach the Control Plane." } },
      503
    );
  }
}
