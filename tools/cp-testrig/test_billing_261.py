"""§261 client billing: the ledger, the expiry rule, the routes and the owner pages.

Three halves, each counted here:
  1. structure: files, wiring, the owner guard, the route contract the website
     types depend on, no hardcoded money, the icon and server-only rules;
  2. rules: billing_harness_261.mjs (Node, fixed inputs, no network);
  3. ledger and routes: omniflow-backend-patch/portal_billing.py on a real Postgres
     (pgserver) through the Flask routes: the three commission bases, fee periods,
     payments, the expiry rule, the paid-time trigger and its backfill, fail-soft.

Run from this folder: python test_billing_261.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

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
    "omniflow-backend-patch/portal_billing.py",
    "lib/omniflow/admin-billing-core.ts",
    "lib/omniflow/admin-billing.ts",
    "app/admin/(panel)/customers/billing/page.tsx",
    "app/admin/(panel)/customers/billing/actions.ts",
    "tools/cp-testrig/billing_harness_261.mjs",
    "tools/cp-testrig/test_billing_261.py",
    "docs/BILLING_261_GUIDE.md",
]
for rel in NEW_FILES:
    check("file present: " + rel, exists(rel), "missing")
    if exists(rel):
        check("marker §261 in " + rel, "§261" in read(rel), "no marker")

app_py = read("omniflow-backend-patch/app.py")
check("app.py imports and registers the billing blueprint",
      "from portal_billing import bp as portal_billing_bp" in app_py
      and "aux_app.register_blueprint(portal_billing_bp)" in app_py, "wiring")
plans_py = read("omniflow-backend-patch/portal_plans.py")
check("portal_plans applies the billing expiry rule in _load_plan",
      "portal_billing.plan_after_expiry(cur, client_id, plan)" in plans_py, "wiring")
billing_py = read("omniflow-backend-patch/portal_billing.py")
routes = re.findall(r"@bp\.(get|put|post|delete)\(", billing_py)
check("five owner routes (GET, settings PUT, client PUT, payment POST, payment DELETE)",
      sorted(routes) == ["delete", "get", "post", "put", "put"], str(routes))
check("owner guard uses the shared service-key check",
      "portal_auth.service_key_ok()" in billing_py, "guard")
check("blueprint path is the admin billing prefix",
      'url_prefix="/api/v1/admin/billing"' in billing_py, "prefix")
check("currency literal appears once, as the database default only",
      billing_py.count("'PKR'") == 1, str(billing_py.count("'PKR'")))
check("paid-time trigger and backfill are in the module",
      "portal_checkout_links_paid_at" in billing_py and "paid_at = updated_at" in billing_py, "trigger")

admin_cp = read("lib/omniflow/admin-control-plane.ts")
check("adminRequest is exported for the billing module",
      "export async function adminRequest(" in admin_cp, "export")
billing_ts = read("lib/omniflow/admin-billing.ts")
check("billing calls go through adminRequest on the billing routes only",
      'adminRequest("api/v1/admin/billing"' in billing_ts
      and billing_ts.count('"api/v1/admin/billing/') >= 4, "paths")
check("no hardcoded host or key in the billing website files",
      not re.search(r"https?://|OMNIFLOW_SERVICE_KEY|X-Omniflow-Key", billing_ts), "secret or host")

page = read("app/admin/(panel)/customers/billing/page.tsx")
actions = read("app/admin/(panel)/customers/billing/actions.ts")
check("billing page and actions are server code (no client directive)",
      '"use client"' not in page and '"use client"' not in actions, "client")
check("billing page is rendered on each request", 'dynamic = "force-dynamic"' in page, "dynamic")
check("every billing action checks the signed-in admin first",
      actions.count("if (!(await signedIn())) finish(") == 4, str(actions.count("if (!(await signedIn())) finish(")))
check("no hardcoded currency in the billing website code",
      "PKR" not in page + actions + billing_ts + read("lib/omniflow/admin-billing-core.ts"), "PKR")

EMOJI = re.compile("[\u2600-\u27BF\U0001F300-\U0001FAFF]")
ts_files = [
    "lib/omniflow/admin-billing-core.ts",
    "lib/omniflow/admin-billing.ts",
    "app/admin/(panel)/customers/billing/page.tsx",
    "app/admin/(panel)/customers/billing/actions.ts",
]
check("icon law: no emoji code points in the billing files",
      not any(EMOJI.search(read(rel)) for rel in ts_files), "emoji")

dash = read("app/admin/(panel)/page.tsx")
check("259 pin kept: dashboard loads sources with allSettled",
      "Promise.allSettled([" in dash, "allSettled")
check("259 pin kept: dashboard makes no fetch and names no Control Plane route",
      "fetch(" not in dash and "/api/v1/" not in dash, "fetch or route")
check("dashboard card links to the billing page",
      'href="/admin/customers/billing"' in dash, "link")

# Route contract: the JSON keys the Control Plane sends must match the website types.
core_ts = read("lib/omniflow/admin-billing-core.ts")


def interface_keys(name):
    match = re.search(r"export interface " + name + r" \{(.*?)\n\}", core_ts, re.S)
    if not match:
        return None
    return set(re.findall(r"^\s+(\w+)\??:", match.group(1), re.M))


CONTRACT = {
    "BillingSettings": interface_keys("BillingSettings"),
    "BillingClient": interface_keys("BillingClient"),
    "BillingTotals": interface_keys("BillingTotals"),
    "BillingPayment": interface_keys("BillingPayment"),
    "BillingOverview": interface_keys("BillingOverview"),
}
for name, keys in CONTRACT.items():
    check("website type " + name + " is readable", bool(keys), "not found")

lib_py = read("tools/cp-testrig/test_lib.py")
check("test_lib defines the billing plan-check switch (scripted suites only)",
      "def neutralize_billing_plan_check(" in lib_py and "§261" in lib_py, "helper")
SCRIPTED_SUITES = ["test_brands.py", "test_growth_pack.py", "test_kb_lang.py",
                   "test_plans_enforce.py", "test_store.py", "test_templates.py", "test_courier.py"]
for name in SCRIPTED_SUITES:
    check("scripted suite switches the billing check off: " + name,
          "neutralize_billing_plan_check(portal_billing)" in read("tools/cp-testrig/" + name),
          "missing call")

# --------------------------------------------------------------- 2. the harness
print("== rules (Node harness) ==")
HARNESS = os.path.join(HERE, "billing_harness_261.mjs")
try:
    proc = subprocess.run(["node", HARNESS], capture_output=True, text=True, timeout=120)
    check("billing harness passes (9 rule checks)",
          proc.returncode == 0 and "SUMMARY 9 passed, 0 failed" in proc.stdout,
          (proc.stdout + proc.stderr)[-300:])
except Exception as exc:  # node missing in a minimal env - the check says so
    check("billing harness ran", False, "node: " + str(exc)[:80])

# ------------------------------------------------- 3. ledger and routes (Postgres)
print("== ledger and routes (real Postgres via pgserver) ==")
sys.path.insert(0, CP)
os.environ["OMNIFLOW_SERVICE_KEY"] = "billing-test-key-261"
os.environ.setdefault("PGSSLMODE", "disable")
KEY = {"X-Omniflow-Key": "billing-test-key-261", "Content-Type": "application/json"}

try:
    import pgserver
    import psycopg2
    have_db = True
except Exception as exc:
    have_db = False
    check("pgserver and psycopg2 importable", False, str(exc)[:120])

if have_db:
    import portal_billing
    import portal_db
    import portal_plans
    from flask import Flask

    pgdir = tempfile.mkdtemp(prefix="billing261_")
    pg = pgserver.get_server(pgdir, cleanup_mode="stop")

    def connect():
        return psycopg2.connect(host=pgdir, dbname="postgres", user="postgres")

    portal_db.SANDBOX_CONN.set(connect)
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    # The two tables the billing module reads, with the same columns as the Control Plane.
    cur.execute("CREATE TABLE portal_profiles (client_id BIGINT PRIMARY KEY,"
                " profile JSONB NOT NULL DEFAULT '{}'::jsonb, updated_by BIGINT,"
                " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute("CREATE TABLE portal_checkout_links (id BIGSERIAL PRIMARY KEY,"
                " client_id BIGINT NOT NULL, contact_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,"
                " title TEXT NOT NULL DEFAULT '', items JSONB NOT NULL DEFAULT '[]'::jsonb,"
                " total NUMERIC(12,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',"
                " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
                " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute("CREATE TABLE portal_plan_settings (client_id BIGINT PRIMARY KEY, plan TEXT NOT NULL)")
    cur.execute("SELECT CURRENT_DATE")
    today = cur.fetchone()[0]

    app = Flask("billing261")
    app.register_blueprint(portal_billing.bp)
    client = app.test_client()

    def call(method, path, body=None, headers=KEY):
        response = getattr(client, method)(path, headers=headers,
                                           data=None if body is None else json.dumps(body))
        return response.status_code, response.get_json(silent=True) or {}

    def ago(days):
        return today - timedelta(days=days)

    def paid_ago(days):
        return datetime.now(timezone.utc) - timedelta(days=days)

    def add_link(client_id, token, status, total, created_ago, paid_at=None):
        cur.execute(
            "INSERT INTO portal_checkout_links (client_id, contact_id, token, title, total,"
            " status, created_at, updated_at, paid_at)"
            " VALUES (%s, 'c', %s, 't', %s, %s, NOW() - make_interval(days => %s), NOW(), %s)",
            (client_id, token, total, status, created_ago, paid_at),
        )

    # Owner's business profile for client 1 gives a name; client 1 has no billing row.
    cur.execute("INSERT INTO portal_profiles (client_id, profile) VALUES (1, %s)",
                (json.dumps({"business_name": "Ali Traders"}),))

    status, body = call("get", "/api/v1/admin/billing", headers={})
    check("no service key gives 403", status == 403, str(status))
    status, body = call("get", "/api/v1/admin/billing")
    check("overview opens with the service key", status == 200, str(status))
    check("settings defaults come from the database (PKR, flag, 7 and 7)",
          body.get("settings", {}).get("currency") == "PKR"
          and body["settings"].get("expiry_mode") == "flag"
          and body["settings"].get("grace_days") == 7
          and body["settings"].get("expiring_soon_days") == 7, str(body.get("settings")))
    client_one = [c for c in body.get("clients", []) if c["client_id"] == 1]
    check("client with a profile and no plan shows as not set up, named from the profile",
          client_one and client_one[0]["kind"] == "unset" and client_one[0]["name"] == "Ali Traders",
          str(client_one[:1]))

    status, _ = call("put", "/api/v1/admin/billing/settings", {"currency": "pk1", "commission_base": "paid_net",
                     "expiry_mode": "flag", "grace_days": 7, "expiring_soon_days": 7})
    check("a currency code that is not 3 letters is refused (400)", status == 400, str(status))
    status, _ = call("put", "/api/v1/admin/billing/settings", {"currency": "PKR", "commission_base": "paid_net",
                     "expiry_mode": "lifetime", "grace_days": 7, "expiring_soon_days": 7})
    check("an unknown expiry mode is refused (400)", status == 400, str(status))
    status, body = call("put", "/api/v1/admin/billing/settings", {"currency": "pkr", "commission_base": "paid_net",
                        "expiry_mode": "flag", "grace_days": 7, "expiring_soon_days": 7})
    check("valid settings save and the currency is stored in capitals",
          status == 200 and body["settings"]["currency"] == "PKR", str(body)[:160])

    # Client 2: subscription 1500 per 30 days, billing started 65 days ago -> 3 periods due.
    status, _ = call("put", "/api/v1/admin/billing/clients/2", {
        "kind": "subscription", "plan_label": "Growth", "fee_amount": "1500", "period_days": 30,
        "commission_percent": "0", "billed_from": ago(65).isoformat(),
        "expires_on": (today + timedelta(days=5)).isoformat(), "note": ""})
    check("subscription plan saves", status == 200, str(status))
    status, _ = call("post", "/api/v1/admin/billing/clients/2/payments", {
        "kind": "fee", "amount": "1500", "received_on": ago(40).isoformat(), "method": "bank"})
    check("fee payment inside the billing window is recorded (201)", status == 201, str(status))

    # Client 3: commission 10%, started 40 days ago. Links cover every case.
    status, _ = call("put", "/api/v1/admin/billing/clients/3", {
        "kind": "commission", "plan_label": "", "fee_amount": "0", "period_days": 30,
        "commission_percent": "10", "billed_from": ago(40).isoformat(), "expires_on": "", "note": ""})
    check("commission plan saves with no expiry", status == 200, str(status))
    add_link(3, "t-paid", "paid", 1000, 20)                          # paid, in window
    add_link(3, "t-deliv", "delivered", 2000, 10)                    # delivered, in window
    add_link(3, "t-cancel-never", "cancelled", 500, 15)              # cancelled, never paid
    add_link(3, "t-open", "open", 999, 12)                           # unpaid, open
    add_link(3, "t-old", "delivered", 7000, 50, paid_at=paid_ago(50))  # before the window
    cur.execute("INSERT INTO portal_checkout_links (client_id, contact_id, token, title, total,"
                " status, created_at, updated_at, paid_at)"
                " VALUES (3, 'c', 't-cancel-after', 't', 300, 'paid', NOW() - make_interval(days => 5),"
                " NOW(), %s)", (paid_ago(5),))
    cur.execute("UPDATE portal_checkout_links SET status = 'cancelled' WHERE token = 't-cancel-after'")
    status, _ = call("post", "/api/v1/admin/billing/clients/3/payments", {
        "kind": "commission", "amount": "150", "received_on": ago(3).isoformat(), "method": "cash"})
    check("commission payment recorded", status == 201, str(status))

    def client_view(client_id):
        _, data = call("get", "/api/v1/admin/billing")
        found = [c for c in data.get("clients", []) if c["client_id"] == client_id]
        return found[0] if found else {}, data

    row, data = client_view(2)
    check("fee due counts three periods (1500 x 3)", row.get("fee_due") == 4500.0, str(row.get("fee_due")))
    check("fee pending is due minus the payment in the window (3000)",
          row.get("fee_pending") == 3000.0, str(row.get("fee_pending")))
    check("plan ending within the window shows as expiring soon",
          row.get("expiry_state") == "expiring_soon" and row.get("days_left") == 5, str(row.get("expiry_state")))

    expected = {"paid_net": (3000.0, 300.0, 150.0), "delivered": (2000.0, 200.0, 50.0),
                "paid_before_cancel": (3300.0, 330.0, 180.0)}
    for base, (sales, due, pending) in expected.items():
        status, _ = call("put", "/api/v1/admin/billing/settings", {
            "currency": "PKR", "commission_base": base, "expiry_mode": "flag",
            "grace_days": 7, "expiring_soon_days": 7})
        row, _ = client_view(3)
        check("commission base " + base + ": sales " + str(sales),
              row.get("sales_base") == sales, str(row.get("sales_base")))
        check("commission base " + base + ": due " + str(due) + ", pending " + str(pending),
              row.get("commission_due") == due and row.get("commission_pending") == pending,
              str(row.get("commission_due")) + "/" + str(row.get("commission_pending")))

    call("put", "/api/v1/admin/billing/settings", {"currency": "PKR", "commission_base": "paid_net",
         "expiry_mode": "flag", "grace_days": 7, "expiring_soon_days": 7})
    _, data = client_view(2)
    row3, _ = client_view(3)
    check("totals add up the clients' pending amounts",
          abs(data["totals"]["payment_pending"] - (row3["payment_pending"] + 3000.0)) < 0.005
          and data["totals"]["commission_pending"] == row3["commission_pending"]
          and data["totals"]["fee_pending"] == 3000.0, str(data["totals"]))
    check("totals count the plan kinds",
          data["totals"]["subscription"] == 1 and data["totals"]["commission"] == 1
          and data["totals"]["unset"] == 1, str(data["totals"]))

    status, _ = call("post", "/api/v1/admin/billing/clients/2/payments", {
        "kind": "fee", "amount": "3000", "received_on": ago(1).isoformat(), "method": "", })
    row, _ = client_view(2)
    check("paying the rest clears the fee pending", status == 201 and row.get("fee_pending") == 0.0,
          str(row.get("fee_pending")))

    status, body = call("post", "/api/v1/admin/billing/clients/2/payments", {
        "kind": "fee", "amount": "10", "received_on": (today + timedelta(days=2)).isoformat()})
    check("a payment dated in the future is refused (400)", status == 400 and "future" in str(body), str(body)[:120])
    status, _ = call("post", "/api/v1/admin/billing/clients/2/payments", {
        "kind": "fee", "amount": "0", "received_on": ago(1).isoformat()})
    check("a zero payment is refused (400)", status == 400, str(status))
    status, _ = call("put", "/api/v1/admin/billing/clients/2", {
        "kind": "lifetime", "fee_amount": "1", "period_days": 30, "commission_percent": "0",
        "billed_from": ago(1).isoformat()})
    check("an unknown billing kind is refused (400)", status == 400, str(status))
    status, _ = call("put", "/api/v1/admin/billing/clients/2", {
        "kind": "commission", "fee_amount": "0", "period_days": 30, "commission_percent": "150",
        "billed_from": ago(1).isoformat()})
    check("a commission above 100 percent is refused (400)", status == 400, str(status))
    status, _ = call("put", "/api/v1/admin/billing/clients/0", {
        "kind": "free", "fee_amount": "0", "period_days": 30, "commission_percent": "0",
        "billed_from": ago(1).isoformat()})
    check("client id 0 is refused (400)", status == 400, str(status))

    # Delete a mistaken payment: it goes, and a second delete says not found.
    status, body = call("post", "/api/v1/admin/billing/clients/2/payments", {
        "kind": "fee", "amount": "5", "received_on": ago(1).isoformat()})
    payment_id = body.get("payment", {}).get("id")
    status_del, _ = call("delete", "/api/v1/admin/billing/payments/%s" % payment_id)
    status_again, _ = call("delete", "/api/v1/admin/billing/payments/%s" % payment_id)
    check("a mistaken payment can be deleted, and a second delete says 404",
          status_del == 200 and status_again == 404, str((status_del, status_again)))

    # The paid-time stamp: set on the first paid status, kept after cancel.
    cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'portal_checkout_links'"
                " AND column_name = 'paid_at'")
    check("checkout links gained a paid_at column", cur.fetchone() is not None, "no column")
    cur.execute("SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'portal_checkout_links_paid_at'")
    check("paid-time trigger exists once", cur.fetchone()[0] == 1, "trigger")
    cur.execute("INSERT INTO portal_checkout_links (client_id, contact_id, token, total, status)"
                " VALUES (9, 'c', 't-stamp', 10, 'open') RETURNING paid_at")
    check("an open order has no paid time", cur.fetchone()[0] is None, "stamped too early")
    cur.execute("UPDATE portal_checkout_links SET status = 'shipped' WHERE token = 't-stamp'")
    cur.execute("SELECT paid_at IS NOT NULL FROM portal_checkout_links WHERE token = 't-stamp'")
    check("moving to shipped stamps the paid time", cur.fetchone()[0] is True, "not stamped")
    cur.execute("UPDATE portal_checkout_links SET status = 'cancelled' WHERE token = 't-stamp'")
    cur.execute("SELECT paid_at IS NOT NULL FROM portal_checkout_links WHERE token = 't-stamp'")
    check("cancelling keeps the paid time", cur.fetchone()[0] is True, "lost")

    # Backfill: an install that had no paid_at gets it from the last update.
    cur.execute("DROP TRIGGER portal_checkout_links_paid_at ON portal_checkout_links")
    cur.execute("ALTER TABLE portal_checkout_links DROP COLUMN paid_at")
    cur.execute("INSERT INTO portal_checkout_links (client_id, contact_id, token, total, status, updated_at)"
                " VALUES (9, 'c', 't-old-paid', 40, 'delivered', NOW() - make_interval(days => 20)),"
                " (9, 'c', 't-old-open', 40, 'open', NOW())")
    conn2 = connect()
    conn2.autocommit = False
    c2 = conn2.cursor()
    portal_billing._ensure(c2)
    conn2.commit()
    conn2.close()
    cur.execute("SELECT paid_at IS NOT NULL, paid_at::date = CURRENT_DATE - 20 FROM portal_checkout_links"
                " WHERE token = 't-old-paid'")
    stamped, same_day = cur.fetchone()
    check("backfill gives an old paid order its paid time from the last update", stamped and same_day,
          str((stamped, same_day)))
    cur.execute("SELECT paid_at IS NULL FROM portal_checkout_links WHERE token = 't-old-open'")
    check("backfill leaves an open order unpaid", cur.fetchone()[0] is True, "stamped open")
    cur.execute("SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'portal_checkout_links_paid_at'")
    check("trigger is back after the ensure step", cur.fetchone()[0] == 1, "missing")

    # Expiry rule on the client's plan (portal_plans._load_plan).
    def plan_for(client_id):
        plan_conn = connect()
        plan_conn.autocommit = False
        plan_cur = plan_conn.cursor()
        value = portal_plans._load_plan(plan_cur, client_id)
        plan_conn.rollback()
        plan_conn.close()
        return value

    cur.execute("INSERT INTO portal_plan_settings (client_id, plan) VALUES (5, 'growth'), (6, 'growth'),"
                " (7, 'growth')")
    call("put", "/api/v1/admin/billing/clients/5", {
        "kind": "subscription", "fee_amount": "100", "period_days": 30, "commission_percent": "0",
        "billed_from": ago(10).isoformat(), "expires_on": ago(3).isoformat()})
    call("put", "/api/v1/admin/billing/clients/6", {
        "kind": "subscription", "fee_amount": "100", "period_days": 30, "commission_percent": "0",
        "billed_from": ago(10).isoformat(), "expires_on": today.isoformat()})

    def set_mode(mode, grace):
        call("put", "/api/v1/admin/billing/settings", {"currency": "PKR", "commission_base": "paid_net",
             "expiry_mode": mode, "grace_days": grace, "expiring_soon_days": 7})

    set_mode("flag", 7)
    check("flag mode: an expired plan stays on", plan_for(5) == "growth", plan_for(5))
    set_mode("grace_then_free", 5)
    check("grace mode: inside the grace days the plan stays on", plan_for(5) == "growth", plan_for(5))
    set_mode("grace_then_free", 2)
    check("grace mode: after the grace days the client gets Free", plan_for(5) == "free", plan_for(5))
    set_mode("free_now", 7)
    check("Free-at-once: an expired plan gives Free", plan_for(5) == "free", plan_for(5))
    check("Free-at-once: a plan that ends today stays on", plan_for(6) == "growth", plan_for(6))
    check("a client with no billing row is never changed", plan_for(7) == "growth", plan_for(7))
    dropped = client_view(5)[0]
    check("overview shows the dropped client as moved to Free",
          dropped.get("dropped_to_free") is True and dropped.get("expiry_state") == "dropped_free",
          str(dropped.get("expiry_state")))

    # Fail soft: no billing tables on this search path -> the stored plan, and the
    # transaction still works afterwards.
    cur.execute("CREATE SCHEMA empty261")
    soft = connect()
    soft.autocommit = False
    soft_cur = soft.cursor()
    soft_cur.execute("SET search_path TO empty261")
    value = portal_billing.plan_after_expiry(soft_cur, 5, "growth")
    soft_cur.execute("SELECT 1")
    usable = soft_cur.fetchone()[0] == 1
    soft.rollback()
    soft.close()
    check("missing billing tables keep the stored plan, and the transaction still works",
          value == "growth" and usable, str((value, usable)))

    # Checkout links missing: the overview still opens, commission sales show 0.
    cur.execute("ALTER TABLE portal_checkout_links RENAME TO portal_checkout_links_away")
    status, data = call("get", "/api/v1/admin/billing")
    cur.execute("ALTER TABLE portal_checkout_links_away RENAME TO portal_checkout_links")
    commission_row = [c for c in data.get("clients", []) if c["client_id"] == 3]
    check("no checkout table: overview still loads, sales count as 0",
          status == 200 and commission_row and commission_row[0]["sales_base"] == 0.0, str(status))

    # The website types match what the Control Plane sends.
    _, data = client_view(2)
    overview_keys = set(data.keys())
    check("overview keys match the website type BillingOverview",
          CONTRACT["BillingOverview"] and overview_keys == CONTRACT["BillingOverview"],
          str(overview_keys ^ (CONTRACT["BillingOverview"] or set())))
    check("settings keys match the website type BillingSettings",
          CONTRACT["BillingSettings"] == set(data["settings"].keys()),
          str(set(data["settings"].keys()) ^ (CONTRACT["BillingSettings"] or set())))
    client_keys = set(client_view(2)[0].keys())
    check("client keys match the website type BillingClient",
          CONTRACT["BillingClient"] == client_keys,
          str(client_keys ^ (CONTRACT["BillingClient"] or set())))
    check("totals keys match the website type BillingTotals",
          CONTRACT["BillingTotals"] == set(data["totals"].keys()),
          str(set(data["totals"].keys()) ^ (CONTRACT["BillingTotals"] or set())))
    payments_row = [p for p in client_view(2)[0].get("payments", [])]
    check("payment keys match the website type BillingPayment",
          bool(payments_row) and CONTRACT["BillingPayment"] == set(payments_row[0].keys()),
          str(payments_row[:1]))

    conn.close()
    shutil.rmtree(pgdir, ignore_errors=True)
else:
    print("  (database checks skipped: pgserver is not installed)")

failures = summary("billing_261")
sys.exit(1 if failures else 0)
