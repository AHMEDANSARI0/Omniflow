import { validateAdminToken, requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/limiter";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { deleteInboundMedia } from "../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

/** §214: owner deletes one stored customer file. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const mediaId = Number.parseInt(id, 10);
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return safeJson({ error: { code: "bad_request", message: "Bad file id." } }, 400);
  }
  return withPortalToken(
    async (token) => serviceResponse(await deleteInboundMedia(token, mediaId)),
    request
  );
}
