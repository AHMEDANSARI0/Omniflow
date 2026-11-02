import { validateAdminToken, requireAdmin } from "../../../../lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "../../../../lib/rate-limit/limiter";
import { getLogger } from "../../../../lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import {
  markSavedReplyUsed,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function POST(
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
  const replyId = Number.parseInt(id, 10);
  if (!Number.isInteger(replyId) || replyId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid saved reply id." } },
      400
    );
  }

  try {
    const ok = await markSavedReplyUsed(accessToken, replyId);
    if (!ok) {
      return safeJson(
        { error: { code: "not_found", message: "Saved reply not found." } },
        404
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
