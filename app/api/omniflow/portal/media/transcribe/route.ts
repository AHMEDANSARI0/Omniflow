import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  transcribeMediaAsset,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  const id =
    payload && typeof payload.id === "number" &&
    Number.isInteger(payload.id) && payload.id > 0
      ? payload.id
      : 0;
  if (!id) {
    return safeJson(
      { error: { code: "bad_request", message: "id is required." } },
      400
    );
  }

  try {
    const result = await transcribeMediaAsset(accessToken, id);
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "portal_unavailable",
            message: "Transcription unavailable - set OMNIFLOW_STT_API_KEY"
                     + " on the CP service or try again shortly.",
          },
        },
        502
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
