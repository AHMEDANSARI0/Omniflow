import {
  ControlPlaneRequestError,
  loginToControlPlane,
} from "../../../../../lib/omniflow/control-plane";
import {
  noStoreHeaders,
  readJsonObject,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";
import { writeSessionCookies } from "../../../../../lib/omniflow/session-cookies";


const LOGIN_FIELDS = new Set(["email", "password", "client_id"]);

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const payload = await readJsonObject(request);
  if (!payload || Object.keys(payload).some((key) => !LOGIN_FIELDS.has(key))) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid login request." } },
      400
    );
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  const rawClientId = payload.client_id;

  if (
    email.length === 0 ||
    email.length > 320 ||
    !email.includes("@") ||
    password.length === 0 ||
    password.length > 1024
  ) {
    return safeJson(
      { error: { code: "bad_request", message: "Email and password are required." } },
      400
    );
  }

  let clientId: number | undefined;
  if (rawClientId !== undefined && rawClientId !== null && rawClientId !== "") {
    const numeric = typeof rawClientId === "string" ? Number(rawClientId) : rawClientId;
    if (!Number.isSafeInteger(numeric) || Number(numeric) <= 0) {
      return safeJson(
        { error: { code: "bad_request", message: "Workspace ID must be a positive number." } },
        400
      );
    }
    clientId = Number(numeric);
  }

  try {
    const session = await loginToControlPlane({
      email,
      password,
      ...(clientId === undefined ? {} : { clientId }),
    });
    await writeSessionCookies(session);

    return safeJson({
      ok: true,
      user_id: session.userId,
      client_id: session.clientId,
      role: session.role,
      access_expires_at: session.accessExpiresAt,
    });
  } catch (error) {
    if (error instanceof ControlPlaneRequestError) {
      if (error.code === "account_locked" || error.status === 423) {
        return safeJson(
          {
            error: {
              code: "account_locked",
              message: "Login is temporarily locked. Please try again later.",
            },
          },
          423
        );
      }
      if (error.code === "client_selection_required" || error.status === 409) {
        return safeJson(
          {
            error: {
              code: "client_selection_required",
              message: "Enter the Workspace ID supplied by OmniFlow.",
            },
          },
          409
        );
      }
      if (error.status === 401) {
        return safeJson(
          {
            error: {
              code: "invalid_credentials",
              message: "The email, password, or Workspace ID is invalid.",
            },
          },
          401
        );
      }
    }

    return safeJson(
      {
        error: {
          code: "authentication_unavailable",
          message: "Login is temporarily unavailable. Please try again.",
        },
      },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
