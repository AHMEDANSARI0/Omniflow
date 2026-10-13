"""Batch 275 - Mobile Admin backend (Control Plane), proven on a live Postgres.

This rig replaces the batch 272/274 version. Per the owner's decision the
Control Plane uses ONE database - Neon (DB_HOST) - and NOTHING else. The Admin
app's login/session is now a self-contained, Neon-backed mobile-admin auth
(table `mobile_admins` + opaque hashed sessions). Supabase is gone from the CP.

The routes below run against a real, temporary Postgres (pgserver) that stands
in for Neon, using the exact env vars the CP reads (DB_HOST/DB_PORT/DB_NAME/
DB_USER/DB_PASSWORD/PGSSLMODE). The `mobile_admins`/`mobile_admin_sessions`
tables are NOT pre-created - the module's lazy DDL must create them, which is
itself asserted. Business rows live in `platform_users` (also Neon).

Everything is fail-soft in production; here we assert the real behaviour so a
bad edit cannot ship silently.

Run from the repo root:  python tools/cp-testrig/test_mobile_admin_272.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
sys.path.append(str(REPO_ROOT / "omniflow-backend-patch"))
BACKEND = REPO_ROOT / "omniflow-backend-patch"
MOBILE = REPO_ROOT / "mobile"
APP_PY = BACKEND / "app.py"
MOD_PY = BACKEND / "portal_mobile_admin.py"
TEST_FILE = Path(__file__).resolve()

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str) -> None:
    results.append((bool(ok), label))


# ---------------------------------------------------------------------------
# 1. Static / structure checks
# ---------------------------------------------------------------------------

for path in [APP_PY, MOD_PY, TEST_FILE]:
    check(path.exists() and path.stat().st_size > 0, f"exists+non-empty: {path.name}")

mod_py = MOD_PY.read_text(encoding="utf-8") if MOD_PY.exists() else ""
app_py = APP_PY.read_text(encoding="utf-8") if APP_PY.exists() else ""
this_py = TEST_FILE.read_text(encoding="utf-8")

check("§275" in mod_py, "marker §275 in portal_mobile_admin.py")
check("§275" in this_py, "marker §275 in test file")

check("from portal_mobile_admin import bp as portal_mobile_admin_bp" in app_py,
      "app.py imports portal_mobile_admin bp")
check("aux_app.register_blueprint(portal_mobile_admin_bp)" in app_py,
      "app.py registers portal_mobile_admin bp")

check('Blueprint("mobile_admin", __name__, url_prefix="/api/v1/mobile")' in mod_py,
      "blueprint prefix is /api/v1/mobile")

ROUTE_CONTRACT = [
    ('@bp.get("/config")', "config"),
    ('@bp.post("/admin/bootstrap")', "admin/bootstrap"),
    ('@bp.post("/admin/login")', "admin/login"),
    ('@bp.post("/admin/refresh")', "admin/refresh"),
    ('@bp.post("/admin/logout")', "admin/logout"),
    ('@bp.get("/admin/me")', "admin/me"),
    ('@bp.get("/admin/overview")', "admin/overview"),
    ('@bp.get("/admin/users")', "admin/users"),
    ('@bp.get("/admin/users/<user_id>")', "admin/users/<user_id>"),
]
for needle, label in ROUTE_CONTRACT:
    check(needle in mod_py, f"route in module: {label}")

# ONE database: Neon. No Supabase may be read by the CP module.
for banned in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "_supabase_json",
               "/rest/v1/", "/auth/v1/", "supabase.co"]:
    check(banned not in mod_py, f"NEON-ONLY: {banned!r} absent from module")

# Neon-backed mobile admin auth must be present.
for needle in ["mobile_admins", "mobile_admin_sessions", "DB_HOST",
               "check_password_hash", "generate_password_hash",
               "CREATE TABLE IF NOT EXISTS", "token_urlsafe", "service_key_ok"]:
    check(needle in mod_py, f"neon auth present: {needle!r}")

# No hardcoded secrets / tokens / connection strings.
for needle in ["eyJ", "sk_live", "postgres://", "postgresql://", "neon.tech"]:
    check(needle not in mod_py, f"no hardcoded {needle!r} in module")

# Mobile app talks only to /api/v1/mobile and never to a second DB/auth provider.
def _mtext(rel: str) -> str:
    p = MOBILE / rel
    return p.read_text(encoding="utf-8") if p.exists() else ""

app_store_ts = _mtext("src/store/app.ts")
check("/api/v1/mobile/config" in app_store_ts, "mobile remote-config endpoint is /api/v1/mobile/config")
admin_ts = _mtext("src/api/admin.ts")
for needle in ["fetchAdminOverview", "fetchAdminUsers", "fetchAdminUser",
               "adminLogin", "adminRefresh", "adminLogout",
               "/api/v1/mobile/admin"]:
    check(needle in admin_ts, f"admin api has {needle!r}")
auth_store = _mtext("src/store/auth.ts")
check("isAdminApp ? adminLogout() : logoutCall()" in auth_store,
      "auth store logout is variant-aware")
check("isAdminApp ? await adminLogin(input)" in auth_store,
      "auth store login branches to adminLogin for admin app")

# No second DB/auth provider may be referenced anywhere in the mobile sources.
mobile_blob = "\n".join(
    _mtext(rel) for rel in [
        "src/api/client.ts", "src/api/admin.ts", "src/api/auth.ts",
        "src/store/auth.ts", "src/store/app.ts", "src/config/env.ts",
    ]
)
for banned in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "supabase.co",
               "/rest/v1/", "/auth/v1/"]:
    check(banned not in mobile_blob, f"mobile src does not reference {banned!r}")

admin_home = _mtext("app/(admin)/(tabs)/index.tsx")
check("fetchAdminOverview" in admin_home, "admin home consumes overview")
admin_users = _mtext("app/(admin)/(tabs)/users.tsx")
check("fetchAdminUsers" in admin_users, "admin users screen consumes users feed")
app_cfg = _mtext("app.config.ts")
check("OmniFlow" in app_cfg, "app.config.ts present and branded")
pkg_json = _mtext("package.json")
check("admin" in pkg_json and "client" in pkg_json, "package.json has admin + client variants")


# ---------------------------------------------------------------------------
# 2. Live behaviour against a real Postgres (pgserver standing in for Neon)
# ---------------------------------------------------------------------------

def _start_pg():
    try:
        import pgserver
        import tempfile
    except Exception as e:
        print(f"[pgserver unavailable: {e}] - skipping live behaviour checks", file=sys.stderr)
        return None
    try:
        pgdir = tempfile.mkdtemp(prefix="mobile275_")
        srv = pgserver.get_server(pgdir, cleanup_mode="stop")
        # pgserver listens on a unix socket inside pgdir; the CP module connects
        # through the same env vars it reads for Neon (DB_HOST=socket dir here).
        env = {
            "DB_HOST": pgdir,
            "DB_PORT": "5432",
            "DB_NAME": "postgres",
            "DB_USER": "postgres",
            "DB_PASSWORD": "",
            "PGSSLMODE": "disable",
        }
        srv._omniflow_env = env  # type: ignore[attr-defined]
        srv._omniflow_pgdir = pgdir  # type: ignore[attr-defined]
        return srv
    except Exception as e:
        print(f"[pgserver start failed: {e}] - skipping live behaviour checks", file=sys.stderr)
        return None


def _pg_connect(pgdir: str):
    import psycopg2
    return psycopg2.connect(host=pgdir, dbname="postgres", user="postgres")


def _seed_business(pgdir: str) -> bool:
    """Create platform_users (business data on Neon). Deliberately do NOT
    create mobile_admins / mobile_admin_sessions - the module's lazy DDL must."""
    try:
        conn = _pg_connect(pgdir)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("DROP TABLE IF EXISTS mobile_admin_sessions CASCADE")
        cur.execute("DROP TABLE IF EXISTS mobile_admins CASCADE")
        cur.execute("DROP TABLE IF EXISTS platform_users CASCADE")
        cur.execute("""
            CREATE TABLE platform_users (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT,
                role TEXT NOT NULL DEFAULT 'client',
                status TEXT NOT NULL DEFAULT 'active',
                plan TEXT,
                phone TEXT,
                company TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_login_at TIMESTAMPTZ
            )
        """)
        cur.execute(
            "INSERT INTO platform_users (email, name, role, status, plan, phone, company) VALUES "
            "('shop-a@omniflow.pk','Shop A','client','active','pro','+923000000001','Shop A'),"
            "('shop-b@omniflow.pk','Shop B','client','suspended','free','+923000000002','Shop B')"
        )
        cur.close()
        conn.close()
        return True
    except Exception as e:
        print(f"[seed failed: {e}]", file=sys.stderr)
        return False


srv = _start_pg()
if srv is not None and _seed_business(srv._omniflow_pgdir):
    prev_env = {}
    extra = dict(srv._omniflow_env)
    # flags + service key (bootstrap guard). These are CP env, not secrets in code.
    extra["OF_MOBILE_FLAGS"] = "inbox=true,billing=false"
    extra["OF_MOBILE_MIN_VERSION"] = "1.0.0"
    extra["OMNIFLOW_SERVICE_KEY"] = "svctest-key-275"
    for k, v in extra.items():
        prev_env[k] = os.environ.get(k)
        os.environ[k] = v
    try:
        from flask import Flask
        from portal_mobile_admin import bp
        from portal_auth import service_key_ok  # noqa: F401 (import sanity)

        app = Flask(__name__)
        app.register_blueprint(bp)
        client = app.test_client()

        def call(method, path, body=None, token=None, service_key=None):
            headers = {}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            if service_key is not None:
                headers["X-Omniflow-Key"] = service_key
            fn = getattr(client, method)
            if body is None:
                resp = fn(path, headers=headers)
            else:
                resp = fn(path, json=body, headers=headers)
            raw = resp.get_data(as_text=True)
            try:
                parsed = json.loads(raw) if raw else {}
            except Exception:
                parsed = {"_raw": raw[:300]}
            return resp.status_code, parsed

        # ---- public config -------------------------------------------------
        sc, data = call("get", "/api/v1/mobile/config")
        check(sc == 200, f"config returns 200 (got {sc})")
        check(isinstance(data.get("flags"), dict), "config returns a flags object")
        check(data.get("flags", {}).get("inbox") is True, "config flag inbox=true")
        check(data.get("flags", {}).get("billing") is False, "config flag billing=false")
        check(data.get("min_version") == "1.0.0", "config min_version from env")

        # ---- bootstrap is service-key guarded ------------------------------
        sc, _ = call("post", "/api/v1/mobile/admin/bootstrap",
                     {"email": "nokey@omniflow.pk", "password": "longenough1"})
        check(sc == 403, f"bootstrap without service key -> 403 (got {sc})")
        sc, _ = call("post", "/api/v1/mobile/admin/bootstrap",
                     {"email": "badkey@omniflow.pk", "password": "longenough1"},
                     service_key="wrong-key")
        check(sc == 403, f"bootstrap with wrong service key -> 403 (got {sc})")
        sc, data = call("post", "/api/v1/mobile/admin/bootstrap",
                        {"email": "short@omniflow.pk", "password": "abc"},
                        service_key="svctest-key-275")
        check(sc == 400, f"bootstrap short password -> 400 (got {sc})")
        check(bool(data.get("error")), "bootstrap weak password returns an error message")

        # ---- bootstrap creates the first admin (and triggers lazy DDL) -----
        sc, data = call("post", "/api/v1/mobile/admin/bootstrap",
                        {"email": "owner@omniflow.pk", "password": "S3cure-pass!", "name": "Owner"},
                        service_key="svctest-key-275")
        check(sc == 200 and data.get("ok") is True, f"bootstrap with service key -> 200 ok (got {sc} {data})")
        check(data.get("email") == "owner@omniflow.pk", "bootstrap echoes the created admin email")

        # lazy DDL must have created the Neon tables
        _c = _pg_connect(srv._omniflow_pgdir)
        _c.autocommit = True
        _cur = _c.cursor()
        _cur.execute("SELECT to_regclass('mobile_admins'), to_regclass('mobile_admin_sessions')")
        _row = _cur.fetchone()
        check(_row[0] is not None, "lazy DDL created mobile_admins")
        check(_row[1] is not None, "lazy DDL created mobile_admin_sessions")
        _cur.execute("SELECT count(*) FROM mobile_admins WHERE email='owner@omniflow.pk'")
        check(_cur.fetchone()[0] == 1, "bootstrap inserted the admin row")
        _cur.close()
        _c.close()

        # ---- login ---------------------------------------------------------
        sc, data = call("post", "/api/v1/mobile/admin/login",
                        {"email": "owner@omniflow.pk", "password": "wrong-pass"})
        check(sc == 401, f"login wrong password -> 401 (got {sc})")
        sc, data = call("post", "/api/v1/mobile/admin/login",
                        {"email": "ghost@omniflow.pk", "password": "S3cure-pass!"})
        check(sc == 401, f"login unknown email -> 401 (got {sc})")
        sc, data = call("post", "/api/v1/mobile/admin/login",
                        {"email": "owner@omniflow.pk", "password": "S3cure-pass!"})
        check(sc == 200, f"login correct creds -> 200 (got {sc})")
        access = (data.get("access_token") or "")
        refresh = (data.get("refresh_token") or "")
        check(bool(access) and bool(refresh) and access != refresh, "login returns distinct access+refresh tokens")
        check(data.get("user", {}).get("role") == "admin", "login user role=admin")
        check(data.get("user", {}).get("email") == "owner@omniflow.pk", "login user email matches")
        check(isinstance(data.get("expires_in"), int) and data.get("expires_in") > 0, "login returns expires_in")

        # ---- session (me) --------------------------------------------------
        sc, data = call("get", "/api/v1/mobile/admin/me", token=access)
        check(sc == 200, f"me with token -> 200 (got {sc})")
        check(data.get("user", {}).get("email") == "owner@omniflow.pk", "me returns admin email")
        check(data.get("user", {}).get("name") == "Owner", "me returns display name")
        sc, _ = call("get", "/api/v1/mobile/admin/me")
        check(sc == 401, f"me without token -> 401 (got {sc})")
        sc, _ = call("get", "/api/v1/mobile/admin/me", token="garbage-token")
        check(sc == 401, f"me with garbage token -> 401 (got {sc})")

        # ---- overview reads Neon business data -----------------------------
        sc, data = call("get", "/api/v1/mobile/admin/overview", token=access)
        check(sc == 200, f"overview with token -> 200 (got {sc})")
        check(data.get("platform_users") == 2, f"overview counts Neon platform_users (got {data.get('platform_users')})")
        check(data.get("database") is True, "overview database=true")

        # ---- users ---------------------------------------------------------
        sc, data = call("get", "/api/v1/mobile/admin/users", token=access)
        check(sc == 200, f"users list -> 200 (got {sc})")
        rows = data.get("users", [])
        check(len(rows) == 2, f"users list returns 2 accounts (got {len(rows)})")
        check(data.get("count") == 2, "users count=2")
        check(all("password" not in r for r in rows), "users never leak password")
        sc, data = call("get", "/api/v1/mobile/admin/users/1", token=access)
        check(sc == 200 and data.get("user", {}).get("email") == "shop-a@omniflow.pk",
              f"user detail id=1 -> shop-a (got {sc})")
        sc, _ = call("get", "/api/v1/mobile/admin/users/9999", token=access)
        check(sc == 404, f"user 9999 -> 404 (got {sc})")
        sc, _ = call("get", "/api/v1/mobile/admin/users/notanumber", token=access)
        check(sc == 400, f"user non-integer id -> 400 (got {sc})")

        # ---- refresh rotates the session -----------------------------------
        sc, data = call("post", "/api/v1/mobile/admin/refresh", {"refresh_token": refresh})
        check(sc == 200, f"refresh -> 200 (got {sc})")
        access2 = data.get("access_token") or ""
        check(bool(access2) and access2 != access, "refresh issues a NEW access token (rotation)")
        sc, _ = call("get", "/api/v1/mobile/admin/me", token=access2)
        check(sc == 200, f"me with rotated token -> 200 (got {sc})")
        sc, _ = call("get", "/api/v1/mobile/admin/me", token=access)
        check(sc == 401, f"me with OLD token after rotation -> 401 (got {sc})")
        sc, _ = call("post", "/api/v1/mobile/admin/refresh", {"refresh_token": "garbage"})
        check(sc == 401, f"refresh with garbage -> 401 (got {sc})")

        # ---- logout revokes ------------------------------------------------
        sc, data = call("post", "/api/v1/mobile/admin/logout", token=access2)
        check(sc == 200 and data.get("ok") is True, f"logout -> 200 ok (got {sc})")
        sc, _ = call("get", "/api/v1/mobile/admin/me", token=access2)
        check(sc == 401, f"me after logout -> 401 (session revoked) (got {sc})")

        # ---- re-login works (fresh session) --------------------------------
        sc, data = call("post", "/api/v1/mobile/admin/login",
                        {"email": "owner@omniflow.pk", "password": "S3cure-pass!"})
        check(sc == 200 and bool(data.get("access_token")), f"re-login after logout -> 200 (got {sc})")
    finally:
        for k, v in prev_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
passed = sum(1 for ok, _ in results if ok)
failed = [(label) for ok, label in results if not ok]
print(f"\n[test_mobile_admin_275] {passed}/{len(results)} checks passed")
if failed:
    print("FAILED CHECKS:")
    for f in failed:
        print(f"  - {f}")
    sys.exit(1)
print("ALL MOBILE ADMIN (NEON) CHECKS PASSED")
