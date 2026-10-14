import { getAnalyticsPins, pinAnalyticsQuestion } from "../../../../../../lib/omniflow/portal";
import { NL_MAX_QUESTION, nlPlanFromBody } from "../../../../../../lib/omniflow/nl-analytics-input";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getAnalyticsPins(accessToken))
  );
}

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const plan = nlPlanFromBody(body.plan);
    if (!question || question.length > NL_MAX_QUESTION || !plan) {
      return safeJson(
        { error: { code: "bad_request", message: "Send the question and its plan." } },
        400
      );
    }
    return serviceResponse(await pinAnalyticsQuestion(accessToken, question, plan));
  }, request);
}
