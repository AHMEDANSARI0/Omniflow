import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteKbEntry,
  requirePortalAccessToken,
  updateKbEntry,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

function parseEntryInput(payload: {
  entry?: {
    title?: unknown;
    category?: unknown;
    keywords?: unknown;
    content?: unknown;
    isActive?: unknown;
  };
} | null):
  | { kind: "ok"; entry: { title: string; category: string; keywords: string; content: string; isActive: boolean } }
  | { kind: "error"; message: string } {
  const input = payload?.entry;
  if (!input) {
    return { kind: "error", message: "entry object is required." };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const keywords = typeof input.keywords === "string" ? input.keywords.trim() : "";
  const category =
    typeof input.category === "string" && input.category.trim()
      ? input.category.trim()
      : "general";
  const isActive = input.isActive !== false;
  if (!title || title.length > 200) {
    return { kind: "error", message: "Title is required (max 200 characters)." };
  }
  if (!content || content.length > 4000) {
    return { kind: "error", message: "Answer is required (max 4000 characters)." };
  }
  if (keywords.length > 600) {
    return { kind: "error", message: "Keywords must be 600 characters or fewer." };
  }
  if (category.length > 60) {
    return { kind: "error", message: "Category must be 60 characters or fewer." };
  }
  return { kind: "ok", entry: { title, category, keywords, content, isActive } };
}

export async function PUT(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as Parameters<
    typeof parseEntryInput
  >[0];
  const parsed = parseEntryInput(payload);
  if (parsed.kind === "error") {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const ok = await updateKbEntry(accessToken, entryId, parsed.entry);
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

export async function DELETE(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  try {
    const ok = await deleteKbEntry(accessToken, entryId);
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
