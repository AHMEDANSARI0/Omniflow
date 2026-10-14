import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  mergeIdentity,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    keep?: unknown;
    merge?: unknown;
  } | null;
  const keep =
    payload && typeof payload.keep === "string" ? payload.keep.trim() : "";
  const merge =
    payload && typeof payload.merge === "string" ? payload.merge.trim() : "";
  if (!keep || !merge) {
    return safeJson(
      { error: { code: "bad_request", message: "Both contacts are required." } },
      400
    );
  }
  if (keep === merge) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick two different contacts." } },
      400
    );
  }

  try {
    const result = await mergeIdentity(accessToken, keep, merge);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if ("error" in result) {
      return safeJson(
        { error: { code: "bad_request", message: result.error } },
        400
      );
    }
    return safeJson({ ok: true, identity: result.identity }, 200);
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
