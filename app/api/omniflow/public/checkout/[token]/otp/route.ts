import {
  requestPublicPhoneOtp,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";


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
  const result = await requestPublicPhoneOtp(clean);
  if (result === "not_found") {
    return safeJson(
      { error: { code: "not_found", message: "This order link is not valid." } },
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
          message: "Too many codes — wait a few minutes.",
        },
      },
      429
    );
  }
  if (result === null) {
    return safeJson(
      {
        error: {
          code: "otp_unavailable",
          message: "Could not send the code — try again shortly.",
        },
      },
      503
    );
  }
  return safeJson(result, 200);
}


