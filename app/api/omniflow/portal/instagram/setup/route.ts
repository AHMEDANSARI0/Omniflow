import { getControlPlanePrincipal } from "../../../../../../lib/omniflow/control-plane";
import { isMetaSetupFix, requirePortalAccessToken, runMetaSetup } from "../../../../../../lib/omniflow/portal";
import { safeJson, sameOrigin } from "../../../../../../lib/omniflow/request-security";
import { publicOrigin } from "../../../../../../lib/omniflow/social-bff";
import { getWorkspaceMetaSetupReport } from "../../../../../lib/workspace-store";

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson({ error: { code: "unauthorized", message: "Sign in required." } }, 401);
  }
  const body: unknown = await request.json().catch(() => ({}));
  const fix = body !== null && typeof body === "object" ? (body as Record<string, unknown>).fix : undefined;
  if (fix !== undefined && !isMetaSetupFix(fix)) {
    return safeJson({ error: { code: "bad_request", message: "Unknown fix." } }, 400);
  }

  let clientId = 1;
  try {
    const p = await getControlPlanePrincipal(accessToken);
    clientId = p.clientId || 1;
  } catch {
    clientId = 1;
  }

  if (!accessToken.startsWith("ofa_neon_")) {
    try {
      const result = await runMetaSetup(accessToken, fix ?? null);
      if (result && !("failed" in result)) {
        return safeJson({ ok: true, ...result }, 200);
      }
    } catch {
      // Fall back to workspace Meta setup report
    }
  }

  const report = await getWorkspaceMetaSetupReport(clientId, publicOrigin(request));
  return safeJson({ ok: true, ...report }, 200);
}
