import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listCustomers,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const rawSearch = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const searchQuery = rawSearch || undefined;
  const channelParam = url.searchParams.get("channel");
  const channelFilter =
    channelParam === "whatsapp" || channelParam === "website"
      ? channelParam
      : undefined;

  try {
    const data = await listCustomers(accessToken, searchQuery, channelFilter);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ customers: data }, 200);
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
