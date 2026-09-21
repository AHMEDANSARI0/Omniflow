import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listBrainTraces,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const raw = new URL(request.url).searchParams.get("conversation_id") ?? "";
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  const conversationId =
    Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

  try {
    const payload = await listBrainTraces(accessToken, conversationId);
    if (payload === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(payload, 200);
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
