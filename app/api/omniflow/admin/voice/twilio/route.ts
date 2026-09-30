import { createClient } from "../../../../../../lib/supabase/server";
import { listAdminTwilioNumbers } from "../../../../../../lib/omniflow/admin-control-plane";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

/** Admin (§214): the Twilio account's numbers and whether each one reaches
 * this Control Plane. */
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
  if (!(await requireAdminSession())) {
    return safeJson(
      { error: { code: "unauthorized", message: "Admin sign in required." } },
      401
    );
  }
  try {
    const result = await listAdminTwilioNumbers();
    if (result.kind === "ok") return safeJson(result.data, 200);
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "twilio_error", message: result.message } },
        result.status
      );
    }
  } catch {
    // fall through
  }
  return safeJson(
    {
      error: {
        code: "twilio_unavailable",
        message: "Could not reach the Control Plane. Please try again.",
      },
    },
    503
  );
}
