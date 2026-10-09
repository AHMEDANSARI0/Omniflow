"""§260 website analytics: the database, the privacy rules and the wiring.

Three halves, each counted here:
  1. structure: files, names, privacy rules in the code, route and cron wiring;
  2. rules: site_analytics_harness.mjs (Node, fixed inputs, no network);
  3. database: the real SQL file on a real Postgres (pgserver): roll-up, delete,
     retention setting, stats window, grants and row-level security.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from test_lib import check, summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(HERE, "..", ".."))

NEW_FILES = [
    "db/site_analytics.sql",
    "lib/omniflow/site-analytics-core.ts",
    "lib/omniflow/site-analytics.ts",
    "app/api/omniflow/public/track/route.ts",
    "app/api/omniflow/cron/site-analytics/route.ts",
    "app/components/SiteAnalytics.tsx",
    "app/admin/(panel)/analytics/page.tsx",
    "tools/cp-testrig/site_analytics_harness.mjs",
]
EDITED_FILES = [
    "app/layout.tsx",
    "app/privacy/page.tsx",
    "lib/omniflow/admin-nav.ts",
    ".env.example",
    "tools/cp-testrig/test_admin_polish_259.py",
    "tools/cp-testrig/admin_dashboard_harness.mjs",
]
EMOJI = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF]")


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf8") as fh:
        return fh.read()


def exists(rel):
    return os.path.exists(os.path.join(ROOT, rel))


def resolves(from_file, spec):
    base = os.path.dirname(os.path.join(ROOT, from_file))
    target = os.path.normpath(os.path.join(base, spec))
    return any(os.path.exists(target + ext) for ext in ("", ".ts", ".tsx", ".mjs", "/index.ts", "/index.tsx"))


print("== files ==")
for rel in NEW_FILES + ["vercel.json"]:
    check("exists: " + rel, exists(rel))
for rel in NEW_FILES + EDITED_FILES:
    check("marker §260 in " + rel, "§260" in read(rel))
# The 259 test keeps the banned-glyph list on purpose, so only the new files are scanned.
for rel in NEW_FILES:
    check("no emoji code points in " + rel, not EMOJI.search(read(rel)))

print("== relative imports resolve ==")
for rel in NEW_FILES[1:] + ["app/layout.tsx", "app/privacy/page.tsx", "lib/omniflow/admin-nav.ts"]:
    if not rel.endswith((".ts", ".tsx", ".mjs")):
        continue
    if rel.endswith("site_analytics_harness.mjs"):
        continue
    for spec in re.findall(r'from\s+["\'](\.[^"\']+)["\']', read(rel)):
        check("import resolves: %s -> %s" % (rel, spec), resolves(rel, spec), spec)

print("== database: text of the SQL file ==")
sql = read("db/site_analytics.sql")
check("SQL: row-level security on all three tables", len(re.findall(r"enable row level security", sql)) == 3)
check("SQL: no IP or user-agent column", not re.search(r"^\s*(ip|ip_address|user_agent)\s+", sql, re.M))
check("SQL: the two functions are service_role only",
      "revoke all on function site_stats(int) from public, anon, authenticated;" in sql
      and "grant execute on function site_stats(int) to service_role;" in sql
      and "revoke all on function site_maintain() from public, anon, authenticated;" in sql
      and "grant execute on function site_maintain() to service_role;" in sql)
check("SQL: tables closed to anon and authenticated",
      "revoke all on site_settings, site_events, site_maintenance_log from anon, authenticated;" in sql)
check("SQL: no daily rollup table and no lifetime total (nothing kept past the window)",
      "site_daily" not in sql and "lifetime_views" not in sql and "rollup_rows" not in sql)
check("SQL: visit records are deleted by age",
      "delete from site_events where created_at < oldest_kept" in sql
      and "delete from site_maintenance_log where ran_at < oldest_kept" in sql)
check("SQL: retention default 90, allowed 1..90",
      "retention_days int not null default 90 check (retention_days between 1 and 90)" in sql)
check("SQL: stats window is clamped to 1..90 days", "least(greatest(coalesce(days, 30), 1), 90)" in sql)
check("SQL: no secret or key literal", not re.search(r"(eyJ|sk_|service_role_key\s*=)", sql))

print("== privacy in the code ==")
server = read("lib/omniflow/site-analytics.ts")
insert = re.search(r"\.insert\(\{(.*?)\}\);", server, re.S)
block = insert.group(1) if insert else ""
check("server: one insert into site_events", insert is not None and "site_events" in server)
check("server: the insert stores no ip and no user agent", not re.search(r"\b(ip|user_agent|userAgent|ip_address)\s*:", block))
check("server: the visitor code is the only identity field", re.search(r"\bvisitor,", block) is not None)
check("server: the IP only goes into the hash", "visitorHash(salt, day, ctx.ip, ctx.userAgent)" in server)
check("server: the day is part of the hash (codes rotate daily)", "const day = new Date().toISOString().slice(0, 10);" in server)
check("server: only the error code is logged", 'console.error("site_events insert failed:", error.code ?? "unknown")' in server)
check("server: nothing recorded without the salt", 'if (!salt) return;' in server and "OF_ANALYTICS_SALT" in server)
check("server: bots are not recorded", "if (isBot(ctx.userAgent)) return;" in server)
client = read("app/components/SiteAnalytics.tsx")
check("client: no cookies, no local or session storage", not re.search(r"document\.cookie|localStorage|sessionStorage", client))
check("client: Do Not Track is respected", 'navigator.doNotTrack === "1"' in client)
check("client: admin, dashboard, API and checkout pages are not measured",
      all(p in client for p in ['"/admin"', '"/dashboard"', '"/api"', '"/c"', '"/store"']))
check("client: sends only a referrer host, never the full referrer URL",
      "new URL(document.referrer).host" in client and "referrer_host: referrerHost" in client)
check("client: posts to the public track route", 'const ENDPOINT = "/api/omniflow/public/track";' in client)
track = read("app/api/omniflow/public/track/route.ts")
check("track: always answers 204", "status: 204" in track and "return done();" in track)
check("track: only same-origin posts are recorded", "sameOrigin(request)" in track)
check("track: JSON body read with the shared size and type guard", "readJsonObject(request)" in track)
cron = read("app/api/omniflow/cron/site-analytics/route.ts")
check("cron: bearer CRON_SECRET, compared in constant time", "sameSecret(given, `Bearer ${secret}`)" in cron)
check("cron: no secret configured means no access", "if (!secret ||" in cron and "401" in cron)

print("== wiring ==")
vercel = json.loads(read("vercel.json"))
crons = vercel.get("crons", [])
check("vercel.json: one daily cron to the retention route",
      len(crons) == 1 and crons[0].get("path") == "/api/omniflow/cron/site-analytics"
      and crons[0].get("schedule") == "0 22 * * *")
layout = read("app/layout.tsx")
check("layout: analytics client mounted once", layout.count("<SiteAnalytics />") == 1
      and 'import SiteAnalytics from "./components/SiteAnalytics";' in layout)
privacy = read("app/privacy/page.tsx")
check("privacy: website analytics section, 90-day deletion, no long-term statistics, and the new date",
      'title: "Website analytics"' in privacy and "kept for up to 90 days and then deleted" in privacy
      and "We keep no long-term statistics." in privacy and "Last updated: October 2026" in privacy)
nav = read("lib/omniflow/admin-nav.ts")
check("nav: Website analytics section at /admin/analytics with the chart icon",
      'label: "Website analytics"' in nav and 'href: "/admin/analytics"' in nav and 'icon: "chart"' in nav)
check("nav: the chart icon exists in the shared registry",
      re.search(r"\bchart: BarChart3\b", read("app/components/ui/Icon.tsx")) is not None)
page = read("app/admin/(panel)/analytics/page.tsx")
check("admin page: dynamic, reads only site_stats through the loader",
      'export const dynamic = "force-dynamic";' in page and "loadSiteStats(days)" in page)
check("admin page: says so when the numbers are unreadable (no fake zeros)", "is not connected yet" in page)
env = read(".env.example")
check(".env.example: both keys present with placeholders only",
      re.search(r"^OF_ANALYTICS_SALT=replace-with", env, re.M) is not None
      and re.search(r"^CRON_SECRET=replace-with", env, re.M) is not None)
check("pins: the 259 nav test counts ten sections", "len(nav_icons) == 10" in read("tools/cp-testrig/test_admin_polish_259.py"))
check("pins: the 259 harness counts ten sections", "assert.equal(ADMIN_NAV.length, 10);" in read("tools/cp-testrig/admin_dashboard_harness.mjs"))

print("== rules (node, fixed inputs) ==")
node = shutil.which("node")
try:
    proc = subprocess.run(
        [node or "node", "--experimental-strip-types", "--no-warnings", os.path.join(HERE, "site_analytics_harness.mjs")],
        cwd=HERE, capture_output=True, text=True, timeout=180,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("PASS "):
            check(line[5:], True, "")
        elif line.startswith("FAIL "):
            check(line[5:], False, line[5:][:160])
    check("rules harness summary reached with no FAIL",
          "SUMMARY[site_analytics_harness]" in proc.stdout and proc.returncode == 0,
          (proc.stderr or proc.stdout)[-160:])
except Exception as exc:  # node missing - the check says so
    check("rules harness ran", False, "node: " + str(exc)[:80])

print("== database (real Postgres via pgserver) ==")
try:
    import pgserver
    import psycopg2
    have_db = True
except Exception as exc:
    have_db = False
    check("pgserver and psycopg2 importable", False, str(exc)[:120])

if have_db:
    data = tempfile.mkdtemp(prefix="sa260_")
    pg = pgserver.get_server(data, cleanup_mode="stop")
    conn = psycopg2.connect(host=data, dbname="postgres", user="postgres")
    conn.autocommit = True
    cur = conn.cursor()

    def one(query, params=None):
        cur.execute(query, params)
        row = cur.fetchone()
        return row[0] if row else None

    for role in ("anon", "authenticated", "service_role"):
        cur.execute("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') "
                    "THEN CREATE ROLE %s NOLOGIN; END IF; END $$;" % (role, role))
    try:
        cur.execute(sql)
        cur.execute(sql)  # running it a second time must be harmless
        check("SQL file applies, and applies again", True)
    except Exception as exc:
        check("SQL file applies, and applies again", False, str(exc)[:160])

    def ev(age, event, path, ref="", src="", medium="", campaign="", device="desktop", browser="chrome",
           country="PK", lang="en", meta="", seconds=0, visitor="v1"):
        return (age, event, path, ref, src, medium, campaign, device, browser, country, lang, meta, seconds, visitor)

    rows = [
        ev(100, "page_view", "/pricing", "google.com", "google", "cpc", "spring", "mobile", "chrome", "PK", "en", visitor="old1"),
        ev(100, "page_view", "/pricing", "google.com", "google", "cpc", "spring", "mobile", "chrome", "PK", "en", visitor="old2"),
        ev(100, "page_time", "/pricing", device="mobile", lang="en", seconds=30, visitor="old1"),
        ev(2, "page_view", "/", lang="ur", visitor="v1"),
        ev(2, "page_view", "/pricing", "google.com", lang="ur", visitor="v1"),
        ev(1, "page_view", "/", device="mobile", browser="safari", country="US", lang="", visitor="v2"),
        ev(1, "cta_click", "/", device="mobile", browser="safari", country="US", meta="/signup", visitor="v2"),
        ev(1, "form_submit", "/contact", device="mobile", browser="safari", country="US", meta="contact-form", visitor="v2"),
        ev(1, "page_time", "/", device="mobile", browser="safari", country="US", seconds=60, visitor="v2"),
    ]
    try:
        cur.executemany(
            "INSERT INTO site_events (created_at, event, path, ref_host, utm_source, utm_medium, utm_campaign, "
            "device, browser, country, lang, meta, seconds, visitor) VALUES "
            "(now() - make_interval(days => %s), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            rows,
        )
        check("seed: nine events inserted", one("SELECT count(*) FROM site_events") == 9)

        result = one("SELECT site_maintain()")
        check("maintain: the three events older than 90 days are deleted",
              result["raw_deleted"] == 3, str(result))
        check("maintain: six recent events remain", one("SELECT count(*) FROM site_events") == 6)
        check("maintain: no daily rollup table exists", one("SELECT to_regclass('public.site_daily')") is None)
        check("maintain: the result has no rollup count", "rollup_rows" not in result, str(result))
        again = one("SELECT site_maintain()")
        check("maintain is idempotent: a second run deletes nothing", again["raw_deleted"] == 0, str(again))
        check("maintenance log records each run", one("SELECT count(*) FROM site_maintenance_log") == 2)
        cur.execute("INSERT INTO site_maintenance_log (ran_at, retention_days, cutoff, raw_deleted) "
                    "VALUES (now() - interval '120 days', 90, now() - interval '210 days', 0)")
        third = one("SELECT site_maintain()")
        check("maintenance log: runs older than the window are deleted, this run is added",
              third["log_rows_deleted"] == 1 and one("SELECT count(*) FROM site_maintenance_log") == 3, str(third))

        stats = one("SELECT site_stats(7)")
        t = stats["totals"]
        check("stats: page views in the window = 3", t["views"] == 3, str(t))
        check("stats: visitors in the window = 2", t["visitors"] == 2, str(t))
        check("stats: one button click, one form submit, one visitor each",
              t["cta_clicks"] == 1 and t["cta_visitors"] == 1 and t["form_submits"] == 1 and t["form_visitors"] == 1)
        check("stats: average time on page = 60 s (time from deleted records is gone)", t["avg_seconds"] == 60)
        check("stats: no lifetime total is returned", "lifetime_views" not in stats, str(sorted(stats)))
        check("stats: two days in the daily series", len(stats["daily"]) == 2)
        check("stats: top page is / with 2 views", stats["pages"][0]["path"] == "/" and stats["pages"][0]["views"] == 2)
        check("stats: direct traffic leads the sources", stats["sources"][0]["source"] == "direct")
        check("stats: campaigns list is empty in this window (UTM rows are older)", stats["campaigns"] == [])
        langs = [x["lang"] for x in stats["languages"]]
        check("stats: languages skip empty values (the empty-language page view is not counted)",
              "" not in langs and sorted(langs) == ["en", "ur"], str(langs))
        check("stats: click and form targets are listed",
              stats["clicks"][0]["target"] == "/signup" and stats["forms"][0]["target"] == "contact-form")
        check("stats: window clamps to 90 days at most", one("SELECT (site_stats(999))->>'days'") == "90")
        check("stats: window clamps to 1 day at least", one("SELECT (site_stats(0))->>'days'") == "1")

        cur.execute("UPDATE site_settings SET retention_days = 30 WHERE id = 1")
        cur.execute("INSERT INTO site_events (created_at, event, path, visitor) "
                    "VALUES (now() - interval '40 days', 'page_view', '/', 'v3')")
        setting = one("SELECT site_maintain()")
        check("retention setting is honoured: 30 days deletes the 40-day-old event",
              setting["retention_days"] == 30 and setting["raw_deleted"] == 1, str(setting))
        cur.execute("UPDATE site_settings SET retention_days = 90 WHERE id = 1")
        try:
            cur.execute("UPDATE site_settings SET retention_days = 120 WHERE id = 1")
            check("retention above 90 days is refused by the database", False)
        except psycopg2.Error:
            check("retention above 90 days is refused by the database", True)
    except Exception as exc:
        check("database scenario ran end to end", False, str(exc)[:200])

    check("grants: anon cannot run site_stats", one("SELECT has_function_privilege('anon', 'site_stats(int)', 'EXECUTE')") is False)
    check("grants: authenticated cannot run site_maintain",
          one("SELECT has_function_privilege('authenticated', 'site_maintain()', 'EXECUTE')") is False)
    check("grants: service_role can run both",
          one("SELECT has_function_privilege('service_role', 'site_stats(int)', 'EXECUTE')") is True
          and one("SELECT has_function_privilege('service_role', 'site_maintain()', 'EXECUTE')") is True)
    check("grants: anon has no table access", one("SELECT has_table_privilege('anon', 'site_events', 'SELECT')") is False)
    check("functions run with definer rights", one("SELECT prosecdef FROM pg_proc WHERE proname = 'site_stats'") is True)
    rls = [one("SELECT relrowsecurity FROM pg_class WHERE relname = %s", (t,)) for t in
           ("site_settings", "site_events", "site_maintenance_log")]
    check("RLS is on for all three tables", all(rls), str(rls))
    check("no policies exist (service role only)", one("SELECT count(*) FROM pg_policies WHERE tablename LIKE 'site_%'") == 0)

    cur.close()
    conn.close()
    try:
        pg.cleanup()
    except Exception:
        pass
    shutil.rmtree(data, ignore_errors=True)

failures = summary("site_analytics_260")
sys.exit(1 if failures else 0)
