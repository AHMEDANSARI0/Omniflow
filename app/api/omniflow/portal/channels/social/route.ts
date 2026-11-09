import { getControlPlanePrincipal } from "../../../../../../lib/omniflow/control-plane";
import { getSocialChannels, requirePortalAccessToken } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import { publicOrigin } from "../../../../../../lib/omniflow/social-bff";
import { getWorkspaceSocialChannelsState } from "../../../../../lib/workspace-store";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
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
      const cp = await getSocialChannels(accessToken);
      if (cp.kind === "ok" && cp.data && Array.isArray(cp.data.channels) && cp.data.channels.length > 0) {
        return safeJson(cp.data, 200);
      }
    } catch {
      // Fallback to workspace social channels state
    }
  }

  const state = await getWorkspaceSocialChannelsState(clientId, publicOrigin(request));
  return safeJson(state, 200);
}
