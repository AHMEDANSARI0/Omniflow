import { askAnalytics, getAnalyticsCatalog } from "../../../../../../lib/omniflow/portal";
import { NL_MAX_QUESTION, nlPlanFromBody } from "../../../../../../lib/omniflow/nl-analytics-input";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

/** One small model call reads the question. */
export const maxDuration = 30;

export async function GET() {
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getAnalyticsCatalog(accessToken))
  );
}

export async function POST(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const plan = nlPlanFromBody(body.plan);
    if (!plan && !question) {
      return safeJson({ error: { code: "bad_request", message: "Type a question." } }, 400);
    }
    if (!plan && question.length > NL_MAX_QUESTION) {
      return safeJson(
        { error: { code: "bad_request", message: "Keep the question under 300 characters." } },
        400
      );
    }
    return serviceResponse(await askAnalytics(accessToken, plan ? { plan } : { question }));
  }, request);
}
