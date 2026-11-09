import { getControlPlanePrincipal } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  verifyInstagramSettings,
} from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";
import { verifyWorkspaceInstagramSettings } from "../../../../../lib/workspace-store";

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

  let clientId = 1;
  try {
    const p = await getControlPlanePrincipal(accessToken);
    clientId = p.clientId || 1;
  } catch {
    clientId = 1;
  }

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const result = await verifyInstagramSettings(accessToken);
      if (result && result !== "not_configured" && !("providerError" in result)) {
        return safeJson(result, 200);
      }
    } catch {
      // Fall back to local verification
    }
  }

  const verified = await verifyWorkspaceInstagramSettings(clientId);
  return safeJson(verified, 200);
}
