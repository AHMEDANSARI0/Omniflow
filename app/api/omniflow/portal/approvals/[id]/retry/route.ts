import { retryApproval } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../../lib/omniflow/voice-vision-bff";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const approvalId = Number((await context.params).id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid approval id." } },
      400
    );
  }
  return withPortalToken(
    async (accessToken) => serviceResponse(await retryApproval(accessToken, approvalId)),
    request
  );
}
