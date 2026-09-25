import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getApiKeyInfo,
  requirePortalAccessToken,
  revokeApiKey,
  rotateApiKey,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const info = await getApiKeyInfo(accessToken);
    return safeJson(info, 200);
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

const ACTIONS: ReadonlySet<string> = new Set(["rotate", "revoke"]);

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    action?: unknown;
  } | null;
  const action =
    payload && typeof payload.action === "string" && ACTIONS.has(payload.action)
      ? payload.action
      : null;
  if (!action) {
    return safeJson(
      { error: { code: "bad_request", message: "Unknown action." } },
      400
    );
  }

  try {
    if (action === "rotate") {
      const result = await rotateApiKey(accessToken);
      return safeJson(result, 200);
    }
    const result = await revokeApiKey(accessToken);
    return safeJson(result, 200);
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
