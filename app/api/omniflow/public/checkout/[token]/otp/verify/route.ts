import {
  verifyPublicPhoneOtp,
} from "../../../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../../lib/omniflow/request-security";


export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const { token } = await context.params;
  const clean = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!clean) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid order link." } },
      400
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).code
      : null;
  const code = typeof raw === "string" ? raw.trim().slice(0, 6) : "";
  if (!/^\d{6}$/.test(code)) {
    return safeJson(
      {
        error: { code: "bad_request", message: "Enter the 6-digit code." },
      },
      400
    );
  }
  const result = await verifyPublicPhoneOtp(clean, code);
  if (result === "not_found") {
    return safeJson(
      {
        error: { code: "not_found", message: "Request a code first." },
      },
      404
    );
  }
  if (result === "feature_off") {
    return safeJson(
      {
        error: {
          code: "feature_off",
          message: "Phone verification is not enabled for this order.",
        },
      },
      409
    );
  }
  if (result === "rate_limited") {
    return safeJson(
      {
        error: {
          code: "rate_limited",
          message: "Too many tries — request a new code.",
        },
      },
      429
    );
  }
  if (result === "bad_code") {
    return safeJson(
      {
        error: {
          code: "bad_code",
          message: "That code is not right — check the WhatsApp message.",
        },
      },
      400
    );
  }
  if (result === null) {
    return safeJson(
      {
        error: {
          code: "otp_unavailable",
          message: "Could not verify right now — try again shortly.",
        },
      },
      503
    );
  }
  return safeJson(result, 200);
}
