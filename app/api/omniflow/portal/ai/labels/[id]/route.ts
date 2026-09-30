import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  archiveAiLabelSet,
  requirePortalAccessToken,
  updateAiLabelSet,
  type AiLabelItem,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

const UNAUTH = { error: { code: "unauthorized", message: "Sign in required." } };
const EXPIRED = { error: { code: "unauthorized", message: "Session expired." } };
const DOWN = {
  error: { code: "portal_unavailable", message: "Try again shortly." },
};

function parseItems(raw: unknown): AiLabelItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AiLabelItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const message =
      typeof row.message === "string" ? row.message.trim().slice(0, 500) : "";
    if (!message) continue;
    const decRaw = String(
      row.expected_decision ?? row.expectedDecision ?? "send"
    ).toLowerCase();
    const expectedDecision =
      decRaw === "handoff" || decRaw === "draft" || decRaw === "send"
        ? decRaw
        : "send";
    const kwSrc = row.expected_keywords ?? row.expectedKeywords;
    const fbSrc = row.forbidden_phrases ?? row.forbiddenPhrases;
    const expectedKeywords = Array.isArray(kwSrc)
      ? kwSrc
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 12)
      : [];
    const forbiddenPhrases = Array.isArray(fbSrc)
      ? fbSrc
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 12)
      : [];
    out.push({
      message,
      expectedDecision,
      expectedKeywords,
      forbiddenPhrases,
      note: typeof row.note === "string" ? row.note.trim().slice(0, 200) : "",
    });
  }
  return out;
}

async function idFrom(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  return Number.parseInt(id ?? "", 10);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const setId = await idFrom(params);
  if (!Number.isFinite(setId) || setId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const name =
    body && typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const notes =
    body && typeof body.notes === "string" ? body.notes.trim().slice(0, 200) : "";
  const items = parseItems(body?.items);
  const isActive = body?.is_active !== false && body?.isActive !== false;
  if (!name || !items || items.length === 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "name and at least one labelled example are required.",
        },
      },
      400
    );
  }
  try {
    const ok = await updateAiLabelSet(accessToken, setId, {
      name,
      notes,
      items,
      isActive,
    });
    if (!ok) return safeJson(DOWN, 503);
    return safeJson({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const setId = await idFrom(params);
  if (!Number.isFinite(setId) || setId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }
  try {
    const ok = await archiveAiLabelSet(accessToken, setId);
    if (!ok) return safeJson(DOWN, 503);
    return safeJson({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
