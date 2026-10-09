// §260 daily website analytics retention job. Vercel Cron calls this route once a
// day (see vercel.json) with `Authorization: Bearer <CRON_SECRET>`. Visit records older
// than the retention window are deleted. No daily totals are kept.
import { safeJson } from "../../../../../lib/omniflow/request-security";
import { runSiteMaintenance, sameSecret } from "../../../../../lib/omniflow/site-analytics";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  if (!secret || !sameSecret(given, `Bearer ${secret}`)) {
    return safeJson({ error: { code: "unauthorized", message: "Not allowed." } }, 401);
  }
  const result = await runSiteMaintenance();
  if (!result.ok) {
    return safeJson({ error: { code: "maintenance_failed", message: result.error } }, 500);
  }
  return safeJson(result.summary, 200);
}
