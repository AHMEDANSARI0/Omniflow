import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  exportConversations,
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

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const statusFilter =
    statusParam === "open" || statusParam === "closed" ? statusParam : "all";
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
  const rawSearch = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const searchQuery = rawSearch || undefined;
  const rawIds = (url.searchParams.get("ids") || "").split(",");
  const ids: number[] = [];
  for (const part of rawIds.slice(0, 100)) {
    const value = Number(part.trim());
    if (part.trim() && Number.isInteger(value) && value > 0 && !ids.includes(value)) {
      ids.push(value);
    }
  }

  try {
    const data = await exportConversations(accessToken, {
      ids: ids.length ? ids : undefined,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
    });
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ conversations: data, count: data.length }, 200);
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
