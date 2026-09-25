from pathlib import Path


ROOT = Path(__file__).resolve().parent


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def main():
    cookies = read("lib/omniflow/session-cookies.ts")
    control = read("lib/omniflow/control-plane.ts")
    proxy = read("proxy.ts")
    login = read("app/dashboard/login/page.tsx")
    routes = "\n".join(
        read(path)
        for path in (
            "app/api/omniflow/auth/login/route.ts",
            "app/api/omniflow/auth/refresh/route.ts",
            "app/api/omniflow/auth/logout/route.ts",
            "app/api/omniflow/auth/me/route.ts",
        )
    )

    assert 'httpOnly: true' in cookies
    assert 'sameSite: "strict"' in cookies
    assert 'secure,' in cookies
    assert 'cache: "no-store"' in control
    assert 'redirect: "error"' in control
    assert "AbortSignal.timeout" in control
    assert "sameOrigin(request)" in routes
    assert "writeSessionCookies" in routes
    assert "clearSessionCookies" in routes
    assert "access_token: session.accessToken" not in routes
    assert "refresh_token: session.refreshToken" not in routes
    assert "localStorage" not in login
    assert "sessionStorage" not in login
    assert "createClient" not in login
    assert "getControlPlanePrincipal" not in proxy

    dashboard_files = list((ROOT / "app" / "dashboard").rglob("*.ts"))
    dashboard_files += list((ROOT / "app" / "dashboard").rglob("*.tsx"))
    for path in dashboard_files:
        source = path.read_text(encoding="utf-8")
        assert "lib/supabase" not in source, path
        assert ".from(" not in source, path

    print("HttpOnly/Secure/SameSite cookie policy: passed")
    print("Server-only Control Plane client: passed")
    print("CSRF origin checks: passed")
    print("Raw token browser response fields: absent")
    print("Browser token storage: absent")
    print("Proxy network authorization calls: absent")
    print("Customer dashboard direct Supabase access: absent")
    print("\nOMNIFLOW WEBSITE AUTH SOURCE CONTRACT PASSED")


if __name__ == "__main__":
    main()
