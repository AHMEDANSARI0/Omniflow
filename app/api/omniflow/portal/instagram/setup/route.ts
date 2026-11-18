import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  runMetaSetup,
  type MetaSetupFix,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const fix: MetaSetupFix | null =
    body.fix === "subscribe_page" || body.fix === "subscribe_app"
      ? body.fix
      : null;

  try {
    const report = await runMetaSetup(accessToken, fix);
    if (report && "failed" in report) {
      return safeJson(
        { error: { code: "meta_setup_failed", message: report.failed } },
        report.status
      );
    }
    if (report) {
      return safeJson(report, 200);
    }
  } catch (error) {
    if (error instanceof ControlPlaneRequestError) {
      return safeJson(
        { error: { code: error.code, message: error.message } },
        error.status
      );
    }
  }

  return safeJson(
    {
      error: {
        code: "meta_setup_unavailable",
        message: "The Meta Graph API setup check could not run right now.",
      },
    },
    503
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
