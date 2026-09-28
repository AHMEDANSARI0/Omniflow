import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteBrainFact,
  listBrainFacts,
  requirePortalAccessToken,
  saveBrainFact,
  type BrainFact,
} from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";

const FACT_KINDS: BrainFact["kind"][] = [
  "policy",
  "sop",
  "pricing",
  "refund",
  "escalation",
  "hours",
];

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const facts = await listBrainFacts(accessToken);
    if (facts === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ facts }, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    id?: unknown;
    kind?: unknown;
    label?: unknown;
    content?: unknown;
    keywords?: unknown;
    is_active?: unknown;
  } | null;

  const kind =
    payload && typeof payload.kind === "string" &&
    (FACT_KINDS as string[]).includes(payload.kind)
      ? (payload.kind as BrainFact["kind"])
      : null;
  if (!kind) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "kind must be one of policy|sop|pricing|refund|escalation|hours.",
        },
      },
      400
    );
  }
  const label =
    payload && typeof payload.label === "string" ? payload.label.trim() : "";
  if (!label || label.length > 120) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "label is required (max 120 characters).",
        },
      },
      400
    );
  }
  const content =
    payload && typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content || content.length > 2000) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "content is required (max 2000 characters).",
        },
      },
      400
    );
  }
  const id =
    payload && typeof payload.id === "number" && Number.isInteger(payload.id)
      ? payload.id
      : 0;
  const keywords =
    payload && typeof payload.keywords === "string"
      ? payload.keywords.slice(0, 200)
      : "";
  const isActive = payload ? payload.is_active !== false : true;

  try {
    const fact = await saveBrainFact(accessToken, {
      id: id > 0 ? id : undefined,
      kind,
      label,
      content,
      keywords,
      isActive,
    });
    if (fact === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ fact }, 200);
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

export async function DELETE(request: Request) {
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

  const id = Number(new URL(request.url).searchParams.get("id") || 0);
  if (!Number.isInteger(id) || id <= 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "id (positive integer) is required.",
        },
      },
      400
    );
  }

  try {
    const ok = await deleteBrainFact(accessToken, id);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
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
