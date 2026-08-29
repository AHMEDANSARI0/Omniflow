import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import { resetPasswordWithCode } from "../../../../../lib/omniflow/forgot-password";
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

  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  const newPassword =
    typeof payload.new_password === "string" ? payload.new_password : "";

  if (!/^\d{6}$/.test(code)) {
    return safeJson(
      { error: { code: "invalid_code", message: "The reset code must be 6 digits." } },
      400
    );
  }
  if (newPassword.length < 8 || newPassword.length > 1024) {
    return safeJson(
      {
        error: {
          code: "weak_password",
          message: "Password must be between 8 and 1024 characters.",
        },
      },
      400
    );
  }

  try {
    await resetPasswordWithCode(code, newPassword);
    return safeJson({ ok: true });
  } catch (error) {
    if (error instanceof ControlPlaneRequestError) {
      if (error.status === 400 || error.status === 409 || error.status === 410) {
        return safeJson(
          {
            error: {
              code: "invalid_code",
              message:
                "This reset code is invalid or has expired. Request a new one.",
            },
          },
          400
        );
      }
      if (error.status === 429) {
        return safeJson(
          {
            error: {
              code: "rate_limited",
              message:
                "Too many attempts. Request a new code and try again later.",
            },
          },
          429
        );
      }
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
