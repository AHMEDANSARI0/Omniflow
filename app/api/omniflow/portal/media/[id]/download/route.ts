import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import { requirePortalAccessToken } from "../../../../../../../lib/omniflow/portal";
import { portalAssetDownload } from "../../../../../../../lib/omniflow/portal-asset";

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
  const assetId = Number.parseInt(id, 10);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Bad asset id." } },
      400
    );
  }

  try {
    const response = await portalAssetDownload(accessToken, assetId);
    if (response === null || !response.ok) {
      return safeJson(
        { error: { code: "not_found", message: "Asset unavailable." } },
        404
      );
    }
    return new Response(await response.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") ??
          "application/octet-stream",
        "Content-Disposition":
          response.headers.get("Content-Disposition") ??
          "attachment",
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

function safeJson(payload: unknown, status: number) {
  return Response.json(payload, { status });
}
