import { listActionRuns } from "../../../../../../lib/omniflow/portal";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

const STATUSES = new Set(["running", "executed", "approval_required", "denied", "error"]);

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("status") ?? "";
  const status = STATUSES.has(raw) ? raw : "";
  return withPortalToken(async (accessToken) =>
    serviceResponse(await listActionRuns(accessToken, status))
  );
}
