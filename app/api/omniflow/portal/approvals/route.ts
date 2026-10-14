import { listApprovals } from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";
import { withPortalToken } from "../../../../../lib/omniflow/voice-vision-bff";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const status = params.get("status") || "pending";
  const kind = params.get("kind") || "";
  return withPortalToken(async (accessToken) => {
    const list = await listApprovals(accessToken, status, kind);
    if (list === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(list, 200);
  });
}
