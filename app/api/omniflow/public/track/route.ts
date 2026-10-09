// §260 website analytics beacon. The browser sends one small JSON event per
// page view, time on page, button click or form submit. Always answers 204:
// analytics must never show an error to a visitor or slow a page.
import { readJsonObject, sameOrigin } from "../../../../../lib/omniflow/request-security";
import { recordSiteEvent } from "../../../../../lib/omniflow/site-analytics";

export const runtime = "nodejs";

function done(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "";
}

export async function POST(request: Request) {
  try {
    // Only our own pages may send events (the browser sends Origin / Sec-Fetch-Site).
    if (!sameOrigin(request)) return done();
    const body = await readJsonObject(request);
    if (body) {
      await recordSiteEvent(body, {
        ip: clientIp(request),
        userAgent: request.headers.get("user-agent") ?? "",
        acceptLanguage: request.headers.get("accept-language") ?? "",
        country: request.headers.get("x-vercel-ip-country") ?? "",
        host:
          request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim() ||
          request.headers.get("host") ||
          "",
      });
    }
  } catch {
    // fail soft: nothing here may reach the visitor
  }
  return done();
}
