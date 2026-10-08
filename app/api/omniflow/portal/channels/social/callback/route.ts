import { finishSocialOAuth } from "../../../../../../../lib/omniflow/portal";
import { publicOrigin } from "../../../../../../../lib/omniflow/social-bff";
import { withPortalToken } from "../../../../../../../lib/omniflow/voice-vision-bff";

export const maxDuration = 60;

/**
 * The platform sends the merchant back here after OAuth. A cross-site
 * navigation by design, so no same-origin check: the one-time state (bound
 * to this workspace on the Control Plane) is the CSRF guard.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? url.searchParams.get("auth_code") ?? "";
  const back = (channel: string, ok: boolean) =>
    Response.redirect(
      publicOrigin(request) + "/dashboard/settings?social=" + encodeURIComponent(channel) + "&result=" + (ok ? "ok" : "error") + "#social",
      303
    );
  if (!state || !code) return back("", false);
  return withPortalToken(async (accessToken) => {
    const result = await finishSocialOAuth(accessToken, state, code);
    return result.kind === "ok" ? back(result.data.channel, true) : back("", false);
  });
}
