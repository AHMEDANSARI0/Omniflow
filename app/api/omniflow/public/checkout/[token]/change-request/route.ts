import {
  submitChangeRequest,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const clean = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!clean) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid order link." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const kind = input.kind === "cancel" ? "cancel" : input.kind === "address" ? "address" : null;
  if (!kind) {
    return safeJson(
      { error: { code: "bad_request", message: "kind must be address or cancel." } },
      400
    );
  }
  const message = typeof input.message === "string" ? input.message.trim().slice(0, 500) : "";
  const addressText =
    typeof input.address_text === "string"
      ? input.address_text.trim().slice(0, 500)
      : "";

  try {
    const result = await submitChangeRequest(clean, {
      kind,
      message,
      addressText,
    });
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if ("error" in result) {
      const status = result.error.message.includes("not valid")
        || result.error.message.includes("expired")
        ? 404
        : result.error.message.includes("waiting")
          ? 409
          : 400;
      return safeJson(
        { error: { code: "bad_request", message: result.error.message } },
        status
      );
    }
    return safeJson({ ok: true }, 200);
  } catch {
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
