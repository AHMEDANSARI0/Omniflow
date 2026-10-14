import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  createKbSource,
  listKbSources,
  requirePortalAccessToken,
  type KbSourceKind,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

const KINDS = ["text", "file", "url"];
// Mirrors OF_KB_SOURCE_CHARS_MAX's ceiling so oversized bodies stop here.
const MAX_TEXT_CHARS = 2_000_000;

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const payload = await listKbSources(accessToken);
    if (payload === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(payload, 200);
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
    kind?: unknown;
    title?: unknown;
    text?: unknown;
    url?: unknown;
    filename?: unknown;
    auto_refresh?: unknown;
  } | null;
  const kind =
    payload && typeof payload.kind === "string" && KINDS.includes(payload.kind)
      ? (payload.kind as KbSourceKind)
      : "";
  const title =
    payload && typeof payload.title === "string" ? payload.title.trim() : "";
  const text = payload && typeof payload.text === "string" ? payload.text : "";
  const url = payload && typeof payload.url === "string" ? payload.url.trim() : "";
  const filename =
    payload && typeof payload.filename === "string"
      ? payload.filename.trim().slice(0, 200)
      : "";
  // §219: automatic refresh is a web-page option only.
  const autoRefresh = kind === "url" && payload?.auto_refresh === true;
  if (!kind) {
    return safeJson(
      { error: { code: "bad_request", message: "kind must be text, file or url." } },
      400
    );
  }
  if (kind === "url" ? !url : !text.trim()) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message:
            kind === "url" ? "A web address is required." : "Text is required.",
        },
      },
      400
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    return safeJson(
      { error: { code: "too_long", message: "That text is too long." } },
      400
    );
  }

  try {
    const result = await createKbSource(accessToken, {
      kind,
      title,
      text: kind === "url" ? undefined : text,
      url: kind === "url" ? url : undefined,
      filename: kind === "file" ? filename : undefined,
      auto_refresh: autoRefresh || undefined,
    });
    if (result.kind === "unavailable") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: result.code, message: result.message } },
        result.status
      );
    }
    return safeJson({ ok: true, source: result.source }, 200);
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
