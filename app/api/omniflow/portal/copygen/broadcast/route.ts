import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  generateBroadcastCopy,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

const LANGS = ["ur", "roman", "en"];

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    topic?: unknown;
    lang?: unknown;
  } | null;
  const topic =
    payload && typeof payload.topic === "string" ? payload.topic.trim() : "";
  const lang =
    payload && typeof payload.lang === "string" && LANGS.includes(payload.lang)
      ? payload.lang
      : "roman";
  if (!topic) {
    return safeJson(
      { error: { code: "bad_request", message: "topic is required." } },
      400
    );
  }

  try {
    const result = await generateBroadcastCopy(
      accessToken,
      topic,
      lang as "ur" | "roman" | "en"
    );
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
