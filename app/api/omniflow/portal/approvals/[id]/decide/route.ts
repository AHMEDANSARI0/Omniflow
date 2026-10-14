import { decideApproval } from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";
import {
  jsonBody,
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
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const decision = String(body.decision || "").trim().toLowerCase();
    if (decision !== "approve" && decision !== "reject") {
      return safeJson(
        { error: { code: "bad_request", message: "Choose approve or reject." } },
        400
      );
    }
    const args =
      body.args !== null && typeof body.args === "object" && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : undefined;
    return serviceResponse(
      await decideApproval(accessToken, approvalId, {
        decision,
        note: typeof body.note === "string" ? body.note : undefined,
        reply: typeof body.reply === "string" ? body.reply : undefined,
        args,
      })
    );
  }, request);
}
