import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  createAiLabelSet,
  listAiLabelSets,
  requirePortalAccessToken,
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
      : typeof kwSrc === "string"
        ? kwSrc
            .split(/[,;|]/)
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
      : typeof fbSrc === "string"
        ? fbSrc
            .split(/[,;|]/)
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

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  try {
    const payload = await listAiLabelSets(accessToken);
    if (payload === null) return safeJson(DOWN, 503);
    return safeJson(
      {
        sets: payload.sets.map((s) => ({
          id: s.id,
          name: s.name,
          notes: s.notes,
          items: s.items.map((item) => ({
            message: item.message,
            expected_decision: item.expectedDecision,
            expected_keywords: item.expectedKeywords,
            forbidden_phrases: item.forbiddenPhrases,
            note: item.note,
          })),
          item_count: s.itemCount,
          is_active: s.isActive,
          updated_at: s.updatedAt,
        })),
        decisions: payload.decisions,
      },
      200
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) return safeJson(UNAUTH, 401);
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const name =
    body && typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const notes =
    body && typeof body.notes === "string" ? body.notes.trim().slice(0, 200) : "";
  const items = parseItems(body?.items);
  if (!name) {
    return safeJson(
      { error: { code: "bad_request", message: "name is required." } },
      400
    );
  }
  if (!items || items.length === 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Add at least one labelled example.",
        },
      },
      400
    );
  }
  try {
    const created = await createAiLabelSet(accessToken, { name, notes, items });
    if (created === null) return safeJson(DOWN, 503);
    return safeJson(
      {
        ok: true,
        set: {
          id: created.id,
          name: created.name,
          notes: created.notes,
          items: created.items,
          item_count: created.itemCount,
          is_active: created.isActive,
        },
      },
      200
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(EXPIRED, 401);
    }
    return safeJson(DOWN, 503);
  }
}
