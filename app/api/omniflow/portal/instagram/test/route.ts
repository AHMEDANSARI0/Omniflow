import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  verifyInstagramSettings,
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

  try {
    const result = await verifyInstagramSettings(accessToken);
    if (result === "not_configured") {
      return safeJson(
        {
          error: {
            code: "not_configured",
            message: "Save your Instagram Account ID and Access Token before verifying.",
          },
        },
        409
      );
    }
    if (result && "providerError" in result) {
      return safeJson(
        { error: { code: "provider_error", message: result.providerError } },
        502
      );
    }
    if (result && "ok" in result) {
      return safeJson(result, 200);
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
        code: "instagram_test_unavailable",
        message: "Could not verify Instagram settings against Meta Graph API.",
      },
    },
    503
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
