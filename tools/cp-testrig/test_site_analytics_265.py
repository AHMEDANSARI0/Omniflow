"""§265 website analytics on Neon through the Control Plane.

Two halves:
  1. structure: files, wiring, the service-key guard, the route contract, the
     privacy law in code (no ip / user agent stored, visitor code only, no
     Supabase left in the server module), the §260 gates still in place;
  2. routes: omniflow-backend-patch/portal_site_analytics.py on a real
     Postgres (pgserver) through the Flask routes: intake validation, the
     stats shape the admin page parses, the retention job and its log, the
     settings row, lazy table creation, and the guard.

Run from this folder: python test_site_analytics_265.py
"""
import os
import re
import sys
import tempfile

from test_lib import check, summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(HERE, "..", ".."))
CP = os.path.join(ROOT, "omniflow-backend-patch")


def read(rel, base=ROOT):
    with open(os.path.join(base, rel), encoding="utf-8") as handle:
        return handle.read()


def exists(rel):
    return os.path.isfile(os.path.join(ROOT, rel))


# ---------------------------------------------------------------- 1. structure
print("== structure ==")
NEW_FILES = [
    "omniflow-backend-patch/portal_site_analytics.py",
    "tools/cp-testrig/test_site_analytics_265.py",
]
for rel in NEW_FILES:
    check("file present: " + rel, exists(rel), "missing")
    if exists(rel):
        check("marker §265 in " + rel, "§265" in read(rel), "no marker")

app_py = read("omniflow-backend-patch/app.py")
check("app.py imports and registers the site analytics blueprint",
      "from portal_site_analytics import bp as portal_site_analytics_bp" in app_py
      and "aux_app.register_blueprint(portal_site_analytics_bp)" in app_py, "wiring")

analytics_py = read("omniflow-backend-patch/portal_site_analytics.py")
routes = re.findall(r"@bp\.(get|post)\(\"(/[^\"]*)\"\)", analytics_py)
check("five routes (event POST, stats/settings/maintenance-log GET, maintain POST)",
      sorted(routes) == sorted([
          ("post", "/event"), ("get", "/stats"), ("post", "/maintain"),
          ("get", "/settings"), ("get", "/maintenance-log")]), str(routes))
check("owner guard uses the shared service-key check",
      "portal_auth.service_key_ok()" in analytics_py, "guard")
check("blueprint path is the admin site-analytics prefix",
      'url_prefix="/api/v1/admin/site-analytics"' in analytics_py, "prefix")
site_events_ddl = re.search(r"CREATE TABLE IF NOT EXISTS site_events \((.*?)\)\s*\"\"\"",
                            analytics_py, re.S)
block_ddl = site_events_ddl.group(1) if site_events_ddl else ""
check("no ip or user agent column in the stored schema",
      site_events_ddl is not None
      and not re.search(r"\b(ip|user_agent|ip_address|useragent)\b", block_ddl, re.I), "privacy")
check("only the three analytics tables are created, no rollups",
      analytics_py.count("CREATE TABLE IF NOT EXISTS") == 3
      and "site_settings" in analytics_py and "site_events" in analytics_py
      and "site_maintenance_log" in analytics_py, "schema")
check("retention window is clamped to 90 days",
      "MAX_DAYS = 90" in analytics_py and "retention_days BETWEEN 1 AND 90" in analytics_py,
      "retention")

server = read("lib/omniflow/site-analytics.ts")
check("server module no longer imports or calls Supabase (§265)",
      "createServiceClient" not in server and "../supabase" not in server
      and ".rpc(" not in server and ".insert(" not in server, "supabase")
check("server module goes through the Control Plane (§265)",
      "adminRequest" in server and "api/v1/admin/site-analytics" in server, "routing")
check("§260 gates survive: bot filter, salt guard, daily hash, rate limit",
      "if (isBot(ctx.userAgent)) return;" in server
      and 'if (!salt) return;' in server
      and "visitorHash(salt, day, ctx.ip, ctx.userAgent)" in server
      and "const day = new Date().toISOString().slice(0, 10);" in server
      and "withinLimit(visitor, Date.now())" in server, "gates")

track = read("app/api/omniflow/public/track/route.ts")
cron = read("app/api/omniflow/cron/site-analytics/route.ts")
check("track and cron routes are unchanged callers of the server module",
      "recordSiteEvent" in track and "runSiteMaintenance" in cron, "callers")

# ------------------------------------------------- 2. routes on a real database
print("== routes on a real Postgres (pgserver) ==")
sys.path.insert(0, CP)
os.environ["OMNIFLOW_SERVICE_KEY"] = "analytics-test-key-265"
os.environ.setdefault("PGSSLMODE", "disable")
KEY = {"X-Omniflow-Key": "analytics-test-key-265", "Content-Type": "application/json"}

try:
    import pgserver
    import psycopg2
    have_db = True
except Exception as exc:
    have_db = False
    check("pgserver and psycopg2 importable", False, str(exc)[:120])

if have_db:
    import portal_site_analytics
    import portal_db
    from flask import Flask

    pgdir = tempfile.mkdtemp(prefix="analytics265_")
    pg = pgserver.get_server(pgdir, cleanup_mode="stop")

    def connect():
        return psycopg2.connect(host=pgdir, dbname="postgres", user="postgres")

    portal_db.SANDBOX_CONN.set(connect)

    app = Flask("analytics265")
    app.register_blueprint(portal_site_analytics.bp)
    client = app.test_client()

    def call(method, path, body=None, headers=KEY):
        response = getattr(client, method)(path, headers=headers,
                                           json=body if body is not None else None)
        try:
            return response.status_code, response.get_json()
        except Exception:
            return response.status_code, None

    base = "/api/v1/admin/site-analytics"

    print("-- guard --")
    status, body = call("get", base + "/settings", headers={"Content-Type": "application/json"})
    check("no service key is rejected with 403", status == 403, str(status))
    status, body = call("get", base + "/settings",
                        headers={"X-Omniflow-Key": "wrong", "Content-Type": "application/json"})
    check("a wrong service key is rejected with 403", status == 403, str(status))

    print("-- settings and lazy tables --")
    status, body = call("get", base + "/settings")
    check("settings route answers 200 and creates the tables on first call",
          status == 200 and body == {"retention_days": 90, "tz_name": "Asia/Karachi"},
          str(body))
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables"
                " WHERE table_name LIKE 'site_%' ORDER BY 1")
    tables = [row[0] for row in cur.fetchall()]
    check("exactly the three site tables exist, nothing else",
          tables == ["site_events", "site_maintenance_log", "site_settings"], str(tables))
    cur.execute("SELECT column_name FROM information_schema.columns"
                " WHERE table_name = 'site_events' ORDER BY ordinal_position")
    columns = [row[0] for row in cur.fetchall()]
    check("site_events stores no ip and no user agent",
          not any(c in ("ip", "ip_address", "user_agent", "useragent") for c in columns),
          str(columns))
    check("the visitor code is the only identity column",
          "visitor" in columns and "session_id" not in columns and "user_id" not in columns,
          str(columns))

    print("-- intake --")
    def event(**kw):
        payload = {"event": "page_view", "path": "/", "visitor": "v1",
                   "device": "mobile", "browser": "Chrome", "country": "PK",
                   "lang": "en", "ref_host": "google.com", "meta": ""}
        payload.update(kw)
        return payload

    status, body = call("post", base + "/event", event())
    check("a valid page view is stored", status == 200 and body == {"ok": True}, str(body))
    call("post", base + "/event", event(visitor="v2", path="/pricing"))
    call("post", base + "/event", event(event="page_time", visitor="v1", seconds=42))
    call("post", base + "/event", event(event="cta_click", visitor="v1", meta="hero_cta"))
    call("post", base + "/event", event(event="form_submit", visitor="v2", meta="contact"))

    status, body = call("post", base + "/event", event(event="explode"))
    check("an unknown event type is refused with 400", status == 400, str(status))
    status, body = call("post", base + "/event", event(visitor=""))
    check("a missing visitor code is refused with 400", status == 400, str(status))
    status, body = call("post", base + "/event", event(path="/clamp", visitor="v3", seconds=999999))
    check("seconds are clamped, never rejected for being large",
          status == 200, str(status))

    print("-- stats --")
    status, body = call("get", base + "/stats?days=30")
    totals = (body or {}).get("totals", {})
    check("stats answer with the shape the admin page parses",
          status == 200 and isinstance(body, dict)
          and all(k in body for k in ("days", "timezone", "totals", "daily", "pages",
                                      "sources", "campaigns", "countries", "devices",
                                      "browsers", "languages", "clicks", "forms")),
          str(sorted((body or {}).keys())))
    check("totals count the seeded events",
          totals.get("views") == 3 and totals.get("visitors") == 3
          and totals.get("cta_clicks") == 1 and totals.get("form_submits") == 1
          and totals.get("avg_seconds") == 42, str(totals))
    pages = {(p.get("path"), p.get("views")) for p in (body or {}).get("pages", [])}
    check("top pages are grouped by path",
          ("/", 1) in pages and ("/pricing", 1) in pages and ("/clamp", 1) in pages,
          str(pages))
    sources = {(s.get("source"), s.get("views")) for s in (body or {}).get("sources", [])}
    check("referrer hosts are reported", ("google.com", 3) in sources, str(sources))
    clicks = {(c.get("target"), c.get("clicks")) for c in (body or {}).get("clicks", [])}
    forms = {(f.get("target"), f.get("submits")) for f in (body or {}).get("forms", [])}
    check("cta and form targets are reported",
          ("hero_cta", 1) in clicks and ("contact", 1) in forms,
          str(clicks) + str(forms))
    status, body = call("get", base + "/stats?days=999")
    check("the window is clamped to 90 days", status == 200 and (body or {}).get("days") == 90,
          str((body or {}).get("days")))
    status, body = call("get", base + "/stats?days=abc")
    check("a broken days value falls back to 30", status == 200 and (body or {}).get("days") == 30,
          str((body or {}).get("days")))

    print("-- retention --")
    cur.execute("INSERT INTO site_events (event, path, visitor, created_at)"
                " VALUES ('page_view', '/old', 'v0', NOW() - INTERVAL '91 days')")
    conn.commit()
    status, body = call("post", base + "/maintain")
    check("the maintenance run reports the window and the deletion",
          status == 200 and (body or {}).get("retention_days") == 90
          and (body or {}).get("raw_deleted") == 1, str(body))
    cur.execute("SELECT COUNT(*) FROM site_events WHERE path = '/old'")
    check("rows older than the window are gone", cur.fetchone()[0] == 0, "kept")
    status, body = call("get", base + "/maintenance-log?limit=5")
    check("the maintenance log keeps the run",
          status == 200 and isinstance(body, list) and len(body) == 1
          and body[0].get("retention_days") == 90 and body[0].get("raw_deleted") == 1,
          str(body))

    cur.close()
    conn.close()

else:
    print("  (database checks skipped: pgserver is not installed)")

failures = summary("site_analytics_265")
sys.exit(1 if failures else 0)
