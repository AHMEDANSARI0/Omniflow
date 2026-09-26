import { createClient } from "../../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import { sendAdminWeeklyReport } from "../../../../../../lib/omniflow/admin-control-plane";
import {
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

export async function POST(request: Request) {
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
  const to = String(body.to || "").trim();
  if (to && !to.includes("@")) {
    return safeJson(
      { error: { code: "bad_request", message: "Enter a valid email." } },
      400
    );
  }
  try {
    const result = await sendAdminWeeklyReport(to);
    return safeJson(result, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.status === 400) {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Set a recipient email first (type one or save 'Reports to').",
          },
        },
        400
      );
    }
    if (error instanceof ControlPlaneRequestError && error.status === 404) {
      return safeJson(
        {
          error: {
            code: "not_found",
            message: "There are no workspaces to report on yet.",
          },
        },
        404
      );
    }
    if (error instanceof ControlPlaneRequestError && error.status === 502) {
      return safeJson(
        {
          error: {
            code: "delivery_failed",
            message:
              "The weekly report email could not be sent — check the saved email settings (Send test email shows the reason).",
          },
        },
        502
      );
    }
    return safeJson(
      {
        error: {
          code: "providers_unavailable",
          message: "Could not reach the email integration. Try again.",
        },
      },
      503
    );
  }
}
