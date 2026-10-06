import { createClient } from "../../../../../../../lib/supabase/server";
import { connectAdminTwilioNumber } from "../../../../../../../lib/omniflow/admin-control-plane";
import { adminBridgeError } from "../../../../../../../lib/omniflow/admin-bridge-error";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";

/** Admin (§214): point one Twilio number's Voice URL + status callback at
 * this Control Plane (explicit, confirmed in the panel). §244: what "sms"
 * points only the number's SMS webhook. */
async function requireAdminSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

export async function POST(request: Request) {
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
  const payload: unknown = await request.json().catch(() => null);
  const sid =
    payload !== null && typeof payload === "object"
      ? String((payload as Record<string, unknown>).sid || "").trim()
      : "";
  if (!/^PN[0-9a-fA-F]{32}$/.test(sid)) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick a number from the Twilio list." } },
      400
    );
  }
  const rawWhat =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>).what : undefined;
  if (rawWhat !== undefined && rawWhat !== "voice" && rawWhat !== "sms") {
    return safeJson({ error: { code: "bad_request", message: "what must be voice or sms." } }, 400);
  }
  try {
    const result = await connectAdminTwilioNumber(sid, rawWhat === "sms" ? "sms" : "voice");
    if (result.kind === "ok") return safeJson(result.data, 200);
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "twilio_error", message: result.message } },
        result.status
      );
    }
  } catch (error) {
    const bridge = adminBridgeError(error);
    if (bridge) return bridge;
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
