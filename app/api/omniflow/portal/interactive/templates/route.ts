import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  createInteractiveTemplate,
  listInteractiveTemplates,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const templates = await listInteractiveTemplates(accessToken);
    if (templates === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ templates }, 200);
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
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const kind = input.kind === "list" ? "list" : "buttons";
  if (!name || rows.length === 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Name and at least one option are required.",
        },
      },
      400
    );
  }

  try {
    const result = await createInteractiveTemplate(accessToken, {
      name,
      kind,
      header: typeof input.header === "string" ? input.header.trim() : "",
      body: typeof input.body === "string" ? input.body.trim() : "",
      footer: typeof input.footer === "string" ? input.footer.trim() : "",
      listLabel: typeof input.list_label === "string" ? input.list_label.trim() : "",
      rows,
    });
    if (result === "bad_request") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message:
              "Check the limits: up to 3 buttons (20 chars) or 10 list rows"
              + " (24 chars), body 1024.",
          },
        },
        400
      );
    }
    if (result === null) {
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
