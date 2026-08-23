import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from "./lib/omniflow/session-constants";


/**
 * Next.js 16 Proxy performs optimistic cookie-presence redirects only.
 * Secure authorization remains in each portal's server-side data layer.
 * Marketing-admin authentication stays on Supabase; customer-dashboard
 * authentication is owned by the OmniFlow Control Plane.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/dashboard")) {
    const isPublicDashboardRoute =
      pathname === "/dashboard/login" ||
      pathname === "/dashboard/reauth" ||
      pathname === "/dashboard/unavailable";

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

  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAdminLogin = pathname === "/admin/login";
  if (!user && !isAdminLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (user && isAdminLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/admin/:path*", "/dashboard/:path*"],
};
