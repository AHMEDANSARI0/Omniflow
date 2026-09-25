import {
  ControlPlaneRequestError,
} from "../../../../../lib/omniflow/control-plane";
import { requestPasswordReset } from "../../../../../lib/omniflow/forgot-password";
import {
  noStoreHeaders,
  readJsonObject,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";


export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const payload = await readJsonObject(request);
  if (!payload) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid request." } },
      400
    );
  }

  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";

  if (email.length === 0 || email.length > 320 || !email.includes("@")) {
    return safeJson(
      { error: { code: "bad_request", message: "A valid email is required." } },
      400
    );
  }

  try {
    await requestPasswordReset(email);

    // Always return the same generic success (prevents account enumeration).
    return safeJson({ ok: true });
  } catch (error) {
    if (error instanceof ControlPlaneRequestError) {
      if (error.status === 404 || error.status === 501) {
        return safeJson(
          {
            error: {
              code: "reset_not_configured",
              message:
                "Password reset is not available on the server yet. Please contact support.",
            },
          },
          501
        );
      }
      if (error.status === 429) {
        return safeJson(
          {
            error: {
              code: "rate_limited",
              message:
                "Too many reset requests. Please wait a few minutes and try again.",
            },
          },
          429
        );
      }
    }

    return safeJson(
      {
        error: {
          code: "reset_unavailable",
          message:
            "Password reset is temporarily unavailable. Please try again.",
        },
      },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
