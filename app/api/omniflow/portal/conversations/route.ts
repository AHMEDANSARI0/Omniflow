import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  bulkConversations,
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
    const needsReplyRaw = url.searchParams.get("needs_reply") || "";
    const needsReplyFilter =
      needsReplyRaw === "1" || needsReplyRaw === "overdue" ? needsReplyRaw : "";
    const sortRaw = url.searchParams.get("sort") || "";
    const sortOrder = sortRaw === "oldest" ? "oldest" : "";
    const assignedRaw = url.searchParams.get("assigned") || "";
    const assignedFilter =
      assignedRaw === "unassigned" || assignedRaw === "me" ? assignedRaw : "";
    const limitRaw = url.searchParams.get("limit") || "";
    const limitNumber = Number(limitRaw);
    const limitFilter =
      limitRaw && Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= 50
        ? limitNumber
        : undefined;
    const result = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyFilter,
      sortOrder,
      assignedFilter,
      true,
      limitFilter
    );
    if (result === null) {
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
    return safeJson(
      { conversations: result.conversations, counts: result.counts },
      200
    );
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

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    action?: unknown;
    ids?: unknown;
    assignee_email?: unknown;
  } | null;
  const action =
    typeof payload?.action === "string" ? payload.action.trim().toLowerCase() : "";
  if (
    action !== "close" &&
    action !== "reopen" &&
    action !== "assign" &&
    action !== "unassign"
  ) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid action." } },
      400
    );
  }
  const rawIds = Array.isArray(payload?.ids) ? payload.ids : [];
  const ids: number[] = [];
  for (const value of rawIds.slice(0, 50)) {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      !ids.includes(value)
    ) {
      ids.push(value);
    }
  }
  if (ids.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Select at least one conversation." } },
      400
    );
  }
  const assigneeEmail =
    action === "assign" && typeof payload?.assignee_email === "string"
      ? payload.assignee_email.trim().toLowerCase().slice(0, 120)
      : "";
  if (action === "assign" && !assigneeEmail) {
    return safeJson(
      { error: { code: "bad_request", message: "Assignee is required." } },
      400
    );
  }

  try {
    const result = await bulkConversations(accessToken, action, ids, assigneeEmail);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
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
