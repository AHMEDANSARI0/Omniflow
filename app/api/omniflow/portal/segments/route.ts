import {
  createSegment,
  listSegments,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const segments = await listSegments(accessToken);
    return safeJson({ segments }, 200);
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

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const rawFilters =
    input.filters !== null && typeof input.filters === "object"
      ? (input.filters as Record<string, unknown>)
      : {};
  const filters: Record<string, unknown> = {};
  if (
    rawFilters.lead_temp === "hot" ||
    rawFilters.lead_temp === "warm" ||
    rawFilters.lead_temp === "cold"
  ) {
    filters.lead_temp = rawFilters.lead_temp;
  }
  if (rawFilters.status === "open" || rawFilters.status === "closed") {
    filters.status = rawFilters.status;
  }
  if (
    rawFilters.stage === "new" ||
    rawFilters.stage === "interested" ||
    rawFilters.stage === "negotiating" ||
    rawFilters.stage === "won" ||
    rawFilters.stage === "lost"
  ) {
    filters.stage = rawFilters.stage;
  }
  if (
    typeof rawFilters.idle_days === "number" &&
    Number.isInteger(rawFilters.idle_days) &&
    rawFilters.idle_days >= 1 &&
    rawFilters.idle_days <= 365
  ) {
    filters.idle_days = rawFilters.idle_days;
  }
  if (typeof rawFilters.tag === "string" && rawFilters.tag.trim()) {
    filters.tag = rawFilters.tag.trim().slice(0, 32);
  }
  if (!name || Object.keys(filters).length === 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "A name and at least one filter are required.",
        },
      },
      400
    );
  }

  try {
    const result = await createSegment(
      accessToken,
      name,
      filters as Parameters<typeof createSegment>[2]
    );
    if (result.kind === "ok") {
      return safeJson({ ok: true, segment: result.segment ?? null }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Pick at least one valid filter.",
          },
        },
        400
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
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
