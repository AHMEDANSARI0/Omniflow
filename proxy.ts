import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_COOKIE,
  ADMIN_SESSION_COOKIE,
  REFRESH_COOKIE,
} from "./lib/omniflow/session-constants";

/**
 * §276 — Next.js 16 Proxy (middleware): optimistic cookie-presence redirects
 * only. Runs in the Edge runtime, so it never touches the database, `pg`, or
 * Node `crypto`. Secure authorization stays in each portal's server-side data
 * layer:
 *   • Marketing admin — real check is `requireSiteAdmin()` against Neon
 *     `admin_sessions`; here we only look for the `of_admin_session` cookie.
 *   • Customer dashboard — authentication is owned by the OmniFlow Control
 *     Plane (`of_access_token` / `of_refresh_token` cookies).
 * There is no Supabase anywhere.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ---- Customer dashboard (Control Plane–owned auth) ----------------------
  if (pathname.startsWith("/dashboard")) {
    const isPublicDashboardRoute =
      pathname === "/dashboard/login" ||
      pathname === "/dashboard/reauth" ||
      pathname === "/dashboard/unavailable" ||
      pathname === "/dashboard/forgot-password" ||
      pathname === "/dashboard/reset-password";

    if (isPublicDashboardRoute) return NextResponse.next({ request });

    const hasAccess = Boolean(request.cookies.get(ACCESS_COOKIE)?.value);
    const hasRefresh = Boolean(request.cookies.get(REFRESH_COOKIE)?.value);

    if (!hasAccess && !hasRefresh) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard/login";
      url.search = "";
      return NextResponse.redirect(url);
    }

    return NextResponse.next({ request });
  }

  if (!pathname.startsWith("/admin")) {
    return NextResponse.next({ request });
  }

  // ---- Marketing admin (Neon session cookie) ------------------------------
  const isAdminLogin = pathname === "/admin/login";
  const hasAdminSession = Boolean(
    request.cookies.get(ADMIN_SESSION_COOKIE)?.value
  );

  if (!hasAdminSession && !isAdminLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (hasAdminSession && isAdminLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request });
}

export const config = {
  matcher: ["/admin/:path*", "/dashboard/:path*"],
};
