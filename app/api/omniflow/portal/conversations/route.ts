import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listConversations,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const url = new URL(request.url);
    const searchQuery = url.searchParams.get("q")?.slice(0, 100) || undefined;
    const statusParam = url.searchParams.get("status");
    const statusFilter =
      statusParam === "open" || statusParam === "closed" ? statusParam : undefined;
    const intentParam = url.searchParams.get("intent");
    const intentFilter =
      intentParam && intentParam !== "all"
        ? intentParam.toLowerCase().slice(0, 40)
        : undefined;
    const channelParam = url.searchParams.get("channel");
    const channelFilter =
      channelParam === "whatsapp" || channelParam === "website"
        ? channelParam
        : undefined;
    const tagParam = url.searchParams.get("tag");
    const tagFilter = tagParam ? tagParam.trim().slice(0, 24) : undefined;
    const needsReplyOnly = url.searchParams.get("needs_reply") === "1";
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyOnly
    );
    if (conversations === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Conversations module is not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ conversations }, 200);
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
