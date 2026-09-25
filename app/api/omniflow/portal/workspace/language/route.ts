import {
  getWorkspaceLanguage,
  requirePortalAccessToken,
  saveWorkspaceLanguage,
  type ReplyLanguage,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";

const LANGS: ReplyLanguage[] = ["auto", "en", "ur", "roman"];


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const language = await getWorkspaceLanguage(accessToken);
    return safeJson({ reply_language: language ?? "auto" }, 200);
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

export async function PUT(request: Request) {
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
  const language = input.language;
  if (typeof language !== "string" || !LANGS.includes(language as ReplyLanguage)) {
    return safeJson(
      { error: { code: "bad_request", message: "Pick auto, en, ur or roman." } },
      400
    );
  }

  try {
    const result = await saveWorkspaceLanguage(
      accessToken,
      language as ReplyLanguage
    );
    if (result.kind === "ok") {
      return safeJson({ ok: true, reply_language: language }, 200);
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
