import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  addTeamMember,
  listTeam,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listTeam(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    email?: unknown;
    name?: unknown;
    role?: unknown;
  } | null;
  const email =
    typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const role = payload?.role === "admin" ? "admin" : "agent";
  if (!email || email.length > 120 || !EMAIL_RE.test(email)) {
    return safeJson(
      { error: { code: "bad_request", message: "A valid email is required." } },
      400
    );
  }
  if (name.length > 80) {
    return safeJson(
      { error: { code: "bad_request", message: "Name must be 80 characters or fewer." } },
      400
    );
  }

  try {
    const result = await addTeamMember(accessToken, email, name, role);
    if (result.kind === "ok") {
      return safeJson({ ok: true, member: result.member }, 200);
    }
    if (result.kind === "exists") {
      return safeJson(
        { error: { code: "email_exists", message: "This email is already on the team." } },
        409
      );
    }
    if (result.kind === "forbidden") {
      return safeJson(
        {
          error: {
            code: "forbidden_role",
            message: "Only the owner or an admin can manage the team.",
          },
        },
        403
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
