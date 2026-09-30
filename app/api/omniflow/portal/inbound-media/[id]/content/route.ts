import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import { requirePortalAccessToken } from "../../../../../../../lib/omniflow/portal";
import { portalInboundMediaContent } from "../../../../../../../lib/omniflow/portal-asset";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

/** Only inert media types are passed through (the Control Plane already
 * sniffs the bytes; this is a second fence at the edge). */
const SAFE_TYPE = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|wav|webm|amr))$/;

/** §214: a customer image / voice note, served inline for the inbox. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const { id } = await params;
  const mediaId = Number.parseInt(id, 10);
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Bad file id." } }, 400);
  }
  try {
    const response = await portalInboundMediaContent(accessToken, mediaId);
    if (response === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (response.status === 401) {
      throw new ControlPlaneRequestError(401, "unauthorized");
    }
    const type = (response.headers.get("Content-Type") ?? "").split(";")[0].trim();
    if (!response.ok || !SAFE_TYPE.test(type)) {
      const status = [404, 409, 410].includes(response.status) ? response.status : 410;
      return safeJson(
        { error: { code: "media_expired", message: "This file is not available." } },
        status
      );
    }
    return new Response(await response.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Disposition":
          response.headers.get("Content-Disposition") ?? "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=300",
      },
    });
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
