import { getApproval } from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const approvalId = Number((await context.params).id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid approval id." } },
      400
    );
  }
  return withPortalToken(async (accessToken) => {
    const result = await getApproval(accessToken, approvalId);
    return serviceResponse(
      result.kind === "ok" ? { kind: "ok", data: { approval: result.data } } : result
    );
  });
}
