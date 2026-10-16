// §276r4g — Control Plane keep-warm job. Vercel Cron pings the CP every 10
// minutes (see vercel.json) so its serverless instance never goes cold: the
// admin dashboard's 15s budget no longer races a Python cold start.
import { safeJson } from "../../../../../lib/omniflow/request-security";
import { sameSecret } from "../../../../../lib/omniflow/site-analytics";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  if (!secret || !sameSecret(given, `Bearer ${secret}`)) {
    return safeJson({ error: { code: "unauthorized", message: "Not allowed." } }, 401);
  }
  const raw = (process.env.OMNIFLOW_CONTROL_PLANE_URL || "").trim();
  if (!raw) {
    return safeJson({ ok: false, reason: "control_plane_not_configured" }, 200);
  }
  try {
    const base = raw.endsWith("/") ? raw : raw + "/";
    const res = await fetch(new URL("api/v1/mobile/config", base), {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return safeJson({ ok: res.ok, status: res.status }, 200);
  } catch (err) {
    return safeJson(
      { ok: false, reason: String((err as Error)?.message || err).slice(0, 200) },
      200,
    );
  }
}
