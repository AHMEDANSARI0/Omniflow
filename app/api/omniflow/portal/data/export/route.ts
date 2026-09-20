import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  fetchDataExport,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export const dynamic = "force-dynamic";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const result = await fetchDataExport(accessToken);
    if (result === null || result.status !== 200) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(result.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition":
          'attachment; filename="' + (result.filename || "omniflow-export.json")
          + '"',
        "Cache-Control": "no-store",
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
