"""§256 Meta - the Control Plane sends Instagram / Messenger replies itself,
plus the live setup check and its two Graph API fixes.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
Units for the switches and routing; then real PostgreSQL (`pgserver`): the
sender through the shared outbox (commands + away replies, refusals, retry,
limit, advisory lock, rollback switch), the bridge poll exclusions, the
webhook -> send-now hook, and setup-check / setup-fix against a scripted
Graph API. Website pins at the end. The database half is skipped when
pgserver is missing.
"""
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time

from test_lib import check, summary, human_principal, PrincipalStub

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.pop("OF_INSTAGRAM_APP_SECRET", None)
os.environ.pop("OF_META_CP_SEND", None)
os.environ["OMNIFLOW_TWILIO_WEBHOOK_BASE"] = "https://cp.example.com"
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
ROOT = os.path.abspath(os.path.join(os.getcwd(), ".."))

import connector_api  # noqa: E402
import portal_channels  # noqa: E402
import portal_instagram as IG  # noqa: E402

print("== switches + routing ==")
check("Control-Plane sending is on by default", IG.CP_SEND is True and connector_api.META_CP_SEND is True)
check("Instagram + Messenger are Control-Plane channels (bridges never poll them)",
      connector_api.CP_DISPATCHED_CHANNELS == ("email", "sms", "instagram", "messenger"))
check("laptop away poll skips Meta DM + comment contacts",
      set(("ig:", "igc:", "fb:", "fbc:")) <= set(connector_api.CP_AWAY_PREFIXES))
check("each queue channel carries its DMs and comments",
      IG.CHANNEL_PREFIXES == {"instagram": ("ig:", "igc:"), "messenger": ("fb:", "fbc:")})
check("own advisory-lock namespace (social uses 24402)", IG.LOCK_CLASS == 24403)
check("throttle + batch come from env with safe bounds",
      5 <= IG.POLL_SECONDS <= 3600 and 1 <= IG.MAX_SEND_PER_RUN <= 50)
check("the bridge dispatch endpoint and the CP sender share one Graph router",
      IG._graph_call("send_message", {"body": "hi", "external_user_id": "fb:P9"}, "fb:P9",
                     {"page_id": "P1", "access_token": "a", "page_access_token": "p"}, None)
      == ("/P1/messages", "p", {"recipient": {"id": "P9"}, "message": {"text": "hi"},
                                "messaging_type": "RESPONSE"}))
CONN = open(os.path.join(os.getcwd(), "connector_api.py"), encoding="utf-8").read()
CONV = open(os.path.join(os.getcwd(), "portal_conversations.py"), encoding="utf-8").read()
check("connector tick kicks the Meta sender in its own guard",
      "                    import portal_instagram\n" in CONN and 'portal_instagram.kick(tenant["client_id"])' in CONN)
check("inbox list kicks the Meta sender", 'portal_instagram.kick(principal.get("client_id"))' in CONV)
needs = IG._setup_needs({"instagram_account_id": "IG1", "access_token": "t", "page_id": "P1",
                         "messenger_enabled": True, "comments_enabled": True})
check("setup needs: IG + Page + Messenger + comments",
      needs["app_fields"] == {"instagram": ["messages", "comments"], "page": ["messages", "feed"]}
      and needs["page_fields"] == ["messages", "feed"]
      and needs["features"] == ["ig_dm", "ig_comments", "messenger", "fb_comments", "page"], needs)
needs = IG._setup_needs({"instagram_account_id": "IG1", "access_token": "t"})
check("setup needs: Instagram only (no Page to subscribe)",
      needs["app_fields"] == {"instagram": ["messages"]} and needs["page_fields"] == ["messages"]
      and not needs["has_page"], needs)


def web():
    print("== website + laptop pins ==")

    def read(rel):
        return open(os.path.join(ROOT, rel), encoding="utf-8").read()

    card = read("app/dashboard/(portal)/settings/InstagramCard.tsx")
    panel = read("app/dashboard/(portal)/settings/MetaSetupPanel.tsx")
    route = read("app/api/omniflow/portal/instagram/setup/route.ts")
    portal = read("lib/omniflow/portal.ts")
    check("settings card shows the setup panel", "<MetaSetupPanel" in card
          and 'import MetaSetupPanel from "./MetaSetupPanel"' in card)
    check("setup panel calls the BFF route, offers both fixes, portal icon set only",
          "/api/omniflow/portal/instagram/setup" in panel and "subscribe_page" in panel
          and "subscribe_app" in panel and "<PortalIcon name={icon}" in panel and "lucide-react" not in panel)
    check("BFF route: same-origin, signed-in, allow-listed fixes only",
          "sameOrigin(request)" in route and "requirePortalAccessToken" in route
          and "isMetaSetupFix(fix)" in route)
    check("portal.ts: setup client hits setup-check / setup-fix",
          "META_SETUP_FIXES" in portal and "/instagram/setup-check" in portal
          and "/instagram/setup-fix" in portal and "export async function runMetaSetup(" in portal)
    check("portal.ts: settings carry the CP sending fields",
          all(s in portal for s in ("cpSends", "lastWebhookAt", "sendError")))
    bridge = read("connector-node/instagram_bridge.py")
    check("laptop bridge knows it is retired and exits instead of looping",
          "§256" in bridge and "no longer needed" in bridge)
    readme = read("connector-node/README.md")
    check("laptop README: Instagram bridge retired, rollback switch named",
          "retired in §256" in readme and "OF_META_CP_SEND" in readme)
    for rel, text in (("MetaSetupPanel.tsx", panel), ("InstagramCard.tsx", card)):
        bad = [ch for ch in text if 0x2190 <= ord(ch) <= 0x2BFF or ord(ch) >= 0x1F000]
        check("icon law: " + rel, bad == [], bad[:5])


try:
    import pgserver
    import psycopg2
except Exception:
    pgserver = None

if pgserver is None:
    print("  skip: pgserver not installed - database half not run")
    web()
    sys.exit(1 if summary("meta_cp_send") else 0)

# ---------------------------------------------------------------------------
# real PostgreSQL
# ---------------------------------------------------------------------------
print("== Meta Control-Plane sending on real PostgreSQL ==")
import tempfile  # noqa: E402

data_dir = tempfile.mkdtemp(prefix="of_metacp_pg_")
server = pgserver.get_server(data_dir, cleanup_mode="stop")
os.environ.update({"DB_HOST": data_dir, "DB_PORT": "5432", "DB_NAME": "postgres",
                   "DB_USER": "postgres", "DB_PASSWORD": "", "PGSSLMODE": "disable"})
import portal_db  # noqa: E402

for mod in (IG, connector_api, portal_channels):
    mod.portal_db = portal_db
check("real portal_db in use", os.path.dirname(os.path.abspath(portal_db.__file__)) == os.getcwd())
from flask import Flask  # noqa: E402


def sql(query, params=None, fetch=True):
    c = psycopg2.connect(host=data_dir, dbname="postgres", user="postgres")
    try:
        with c.cursor() as cur:
            cur.execute(query, params)
            got = cur.fetchall() if fetch and cur.description else None
        c.commit()
        return got
    finally:
        c.close()


def one(query, params=None):
    rows = sql(query, params)
    return rows[0] if rows else None


portal_db.ensure_tables()
for ddl in ("ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'",
            "ADD COLUMN IF NOT EXISTS result_note TEXT",
            "ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"):
    sql("ALTER TABLE portal_connector_commands " + ddl, fetch=False)
import portal_events  # noqa: E402
import portal_identity  # noqa: E402

_c = portal_db._conn()
with _c.cursor() as _cur:
    # production has these (outbox columns, identity tables)
    portal_events._ensure_ddl(_cur)
    portal_identity._ensure_ddl(_cur)
    import portal_ratelimit  # noqa: E402
    portal_ratelimit._ensure_ddl(_cur)
    _cur.execute("CREATE TABLE IF NOT EXISTS client_settings (client_id BIGINT PRIMARY KEY,"
                 " settings JSONB NOT NULL DEFAULT '{}'::jsonb)")
    # created by the old migration 012 in production
    _cur.execute("CREATE TABLE IF NOT EXISTS portal_kb_settings (client_id BIGINT PRIMARY KEY,"
                 " auto_reply BOOLEAN NOT NULL DEFAULT FALSE)")
_c.commit()
import glob  # noqa: E402
import importlib  # noqa: E402
import inspect  # noqa: E402

# the ingest core runs many best-effort hooks; production has their tables,
# so create them the way production did: every module's own DDL helper
for _pass in (1, 2):
    for _path in sorted(glob.glob("portal_*.py")):
        if _path == "portal_instagram.py":  # its migration is tested below
            continue
        try:
            _m = importlib.import_module(_path[:-3])
        except Exception:
            continue
        for _name, _fn in inspect.getmembers(_m, inspect.isfunction):
            if not _name.startswith("_ensure") or _fn.__module__ != _m.__name__:
                continue
            if len(inspect.signature(_fn).parameters) != 1:
                continue
            for _arg in ("conn", "cur"):
                try:
                    if _arg == "conn":
                        _fn(_c)
                    else:
                        with _c.cursor() as _cur:
                            _fn(_cur)
                    _c.commit()
                    break
                except Exception:
                    _c.rollback()
_c.close()
sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT, action TEXT, actor_kind TEXT, actor_user_id BIGINT,"
    " conversation_id BIGINT, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)

IG._DDL_READY = False
_c = portal_db._conn()
IG._ensure_instagram_tables(_c)
_c.close()
connector_api._ensure_away_table()
cols = {r[0] for r in sql("SELECT column_name FROM information_schema.columns"
                          " WHERE table_name = 'portal_instagram_accounts'")}
check("settings table gains the sending / setup bookkeeping columns",
      {"last_webhook_at", "last_sent_at", "send_error"} <= cols, cols)

OWNER = human_principal(client_id=1, user_id=11)
app = Flask("meta_cp_send_test")
for blueprint in (IG.bp, IG.public_bp, IG.connector_bp, connector_api.bp):
    app.register_blueprint(blueprint)
client = app.test_client()
stub = PrincipalStub(IG, OWNER)
SVC = {"X-Omniflow-Key": os.environ["OMNIFLOW_SERVICE_KEY"]}

r = client.put("/api/v1/portal/instagram/settings", json={
    "page_id": "P1", "access_token": "ig-tok", "page_access_token": "page-tok",
    "app_secret": "app-sec", "verify_token": "ver-1", "messenger_enabled": True,
    "comments_enabled": True})
check("settings saved", r.status_code == 200, r.get_data(as_text=True)[:300])
sql("UPDATE portal_instagram_accounts SET instagram_account_id = 'IG1' WHERE client_id = 1", fetch=False)
got = client.get("/api/v1/portal/instagram/settings").get_json()["settings"]
check("settings say the Control Plane sends (no bridge), nothing sent yet",
      got["cpSends"] is True and got["lastSentAt"] is None and got["sendError"] is None
      and got["lastWebhookAt"] is None, got)

seen = []
SCRIPT = {}


def fake_meta(method, path, token, payload=None):
    seen.append((method, path, token, payload))
    hit = SCRIPT.get(method + " " + path.split("?")[0])
    if isinstance(hit, Exception):
        raise hit
    if callable(hit):
        return hit(path, token, payload)
    if hit is not None:
        return hit
    if payload and (payload.get("message") or {}).get("text") == "BOOM":
        raise IG.MetaGraphError(400, "(#10) Outside the allowed window.")
    return {"message_id": "mid." + str(len(seen)), "id": "c." + str(len(seen))}


IG._meta_request = fake_meta


def command(contact, source="manual", action="send_message", body="Ji, 3 din mein.", channel=None):
    payload = {"external_user_id": contact, "body": body, "source": source}
    return one("INSERT INTO portal_connector_commands (client_id, action, payload, status, channel)"
               " VALUES (1, %s, %s, 'pending', %s) RETURNING id",
               (action, json.dumps(payload), channel or portal_channels.channel_for_contact(contact)))[0]


def away(contact, body="Abhi team offline hai."):
    return one("INSERT INTO portal_away_replies (client_id, contact_id, body) VALUES (1, %s, %s)"
               " RETURNING id", (contact, body))[0]


def status(cid):
    return one("SELECT status FROM portal_connector_commands WHERE id = %s", (cid,))[0]


def away_status(aid):
    return one("SELECT status FROM portal_away_replies WHERE id = %s", (aid,))[0]


def account():
    return one("SELECT send_error, last_sent_at, last_webhook_at FROM portal_instagram_accounts"
               " WHERE client_id = 1")


print("== sender ==")
c_wait = command("ig:S1")
res = IG.send_pending(1)
check("not verified yet -> nothing spent, reply waits, owner told why",
      res["ran"] and res["sent"] == 0 and not seen and status(c_wait) == "pending"
      and "Check connection" in res["error"] and "Check connection" in account()[0], (res, account()))
sql("UPDATE portal_instagram_accounts SET enabled = TRUE WHERE client_id = 1", fetch=False)
IG._record_comments(1, [{"from": "igc:IGU1", "body": "Size M?", "comment": {
    "id": "17c1", "platform": "instagram", "post_id": "M1"}}])
c_fb = command("fb:PSID9", body="Price 2500 hai.")
c_wa = command("923001234567", channel="whatsapp")
a_dm = away("fb:PSID7")
a_comment = away("igc:IGU1")
res = IG.send_pending(1)
paths = [(s[1], s[2]) for s in seen]
check("queued IG DM + Messenger reply + DM away reply sent through Graph",
      res["sent"] == 3 and ("/IG1/messages", "ig-tok") in paths and ("/P1/messages", "page-tok") in paths
      and status(c_wait) == "done" and status(c_fb) == "done" and away_status(a_dm) == "sent",
      (res, paths))
check("an away reply never becomes a public comment: refused, not sent",
      res["refused"] == 1 and away_status(a_comment) == "failed"
      and not any(p.endswith("/replies") for p, _ in paths), (res, paths))
check("WhatsApp commands are left for the laptop", status(c_wa) == "pending")
row = account()
check("success clears the problem and stamps last_sent_at", row[0] == "" and row[1] is not None, row)
out = sql("SELECT m.body FROM portal_messages m JOIN portal_conversations c ON c.id = m.conversation_id"
          " WHERE c.client_id = 1 AND m.direction = 'out' AND c.contact_id = 'fb:PSID9'")
check("the sent reply shows in the conversation (direction out)",
      [r[0] for r in out] == ["Price 2500 hai."], out)
note = one("SELECT result_note FROM portal_connector_commands WHERE id = %s", (c_fb,))[0]
check("command note says Meta accepted it", note == "Meta accepted the message.", note)

seen.clear()
c_boom = command("ig:S2", body="BOOM")
res = IG.send_pending(1)
row = one("SELECT status, next_attempt_at FROM portal_connector_commands WHERE id = %s", (c_boom,))
check("Meta error -> command kept for retry with a back-off, problem shown",
      res["failed"] == 1 and row[0] == "pending" and row[1] is not None
      and account()[0] == "Meta: (#10) Outside the allowed window.", (res, row, account()))
res = IG.send_pending(1)
check("not retried before its back-off time", res["sent"] == 0 and res["failed"] == 0 and len(seen) == 1, res)
sql("UPDATE portal_connector_commands SET status = 'dead' WHERE id = %s", (c_boom,), fetch=False)

seen.clear()
c_sq = command("fbc:U1", source="sequence")
res = IG.send_pending(1)
check("automation never posts a public comment (refused, final, not sent)",
      res["refused"] == 1 and status(c_sq) == "dead" and not seen, res)

ids = [command("ig:S" + str(n)) for n in range(3, 6)]
res = IG.send_pending(1, limit=1)
check("limit respected (one per run when asked)", res["sent"] == 1
      and [status(i) for i in ids].count("done") == 1, res)
res = IG.send_pending(1)
check("the rest go on the next run", all(status(i) == "done" for i in ids), res)

holder = psycopg2.connect(host=data_dir, dbname="postgres", user="postgres")
with holder.cursor() as cur:
    cur.execute("SELECT pg_advisory_lock(%s, %s)", (IG.LOCK_CLASS, 1))
c_lock = command("ig:S9")
res = IG.send_pending(1)
check("another sender holds the workspace lock -> skipped, nothing sent twice",
      res["reason"] == "busy" and status(c_lock) == "pending", res)
holder.close()
check("lock released -> sent", IG.send_pending(1)["sent"] == 1 and status(c_lock) == "done")

IG.CP_SEND = False
c_off = command("ig:S10")
res = IG.send_pending(1)
check("OF_META_CP_SEND=0 rollback: CP sends nothing, kick is a no-op",
      res["reason"] == "off" and status(c_off) == "pending" and IG.kick(1) is False, res)
IG.CP_SEND = True
sql("UPDATE portal_connector_commands SET status = 'dead' WHERE id = %s", (c_off,), fetch=False)

print("== tick hooks ==")
calls = []
real_send = IG.send_pending
IG.send_pending = lambda cid, limit=0: calls.append((cid, limit)) or {}
IG._LAST.clear()
IG._RUNNING.clear()
first = IG.kick(1)
for t in threading.enumerate():
    if t.name == "meta-1":
        t.join(5)
check("kick sends in the background", first is True and calls == [(1, 0)], calls)
check("kick throttled per workspace", IG.kick(1) is False and len(calls) == 1)
check("kick ignores bad workspace ids", IG.kick(0) is False and IG.kick("x") is False and IG.kick(None) is False)
portal_channels.dispatch_now(1, "messenger")
check("a teammate reply on Messenger is sent right away",
      calls[-1] == (1, IG.DISPATCH_LIMIT), calls)


def post(payload, secret="app-sec"):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return client.post("/api/v1/public/meta/webhook", data=raw,
                       headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig})


calls.clear()
r = post({"object": "instagram", "entry": [{"id": "IG1", "messaging": [
    {"sender": {"id": "S77"}, "recipient": {"id": "IG1"}, "message": {"mid": "m.77", "text": "Salam"}}]}]})
check("signed webhook ingests, then sends what it queued right away",
      r.status_code == 200 and r.get_json()["inserted"] == 1 and calls == [(1, IG.DISPATCH_LIMIT)],
      (r.get_data(as_text=True)[:200], calls))
check("the event is stamped for the setup check", account()[2] is not None)
calls.clear()
r = post({"object": "instagram", "entry": [{"id": "IG1", "messaging": []}]}, secret="wrong")
check("unsigned / wrongly signed webhook sends nothing", r.status_code in (401, 403) and calls == [],
      r.status_code)
IG.send_pending = real_send

print("== laptop bridge exclusions ==")
c_ig = command("ig:S20")
a_ig = away("ig:S21")
r = client.get("/api/v1/connector/whatsapp/commands?client_id=1", headers=SVC)
chans = {c.get("channel") for c in (r.get_json() or {}).get("commands", [])}
check("the WhatsApp bridge never receives Instagram / Messenger commands",
      r.status_code == 200 and not chans & {"instagram", "messenger"}
      and status(c_ig) == "pending", (r.status_code, chans))
for ch in ("instagram", "messenger"):
    r = client.get("/api/v1/connector/whatsapp/commands?client_id=1&channel=" + ch, headers=SVC)
    check("bridge poll with channel=" + ch + " refused (400)", r.status_code == 400, r.status_code)
r = client.get("/api/v1/connector/away-replies?client_id=1", headers=SVC)
contacts = [a.get("contact_id") for a in (r.get_json() or {}).get("away_replies", [])]
check("laptop away poll never hands out Meta away replies",
      r.status_code == 200 and not any(str(c).startswith(("ig:", "igc:", "fb:", "fbc:")) for c in contacts)
      and away_status(a_ig) == "pending", (r.status_code, contacts))
check("old bridge dispatch endpoint still works (rollback path)",
      client.post("/api/v1/connector/instagram/commands/dispatch", headers=SVC,
                  json={"client_id": 1, "command_id": c_ig}).status_code == 200 and status(c_ig) == "done")

print("== setup check ==")
APP_SUBS = {"data": [
    {"object": "instagram", "callback_url": "https://cp.example.com/api/v1/public/meta/webhook",
     "active": True, "fields": [{"name": "messages"}, {"name": "comments"}]},
    {"object": "page", "callback_url": "https://cp.example.com/api/v1/public/meta/webhook",
     "active": True, "fields": [{"name": "messages"}, {"name": "feed"}]}]}
ALL_SCOPES = ["instagram_manage_messages", "instagram_manage_comments", "pages_messaging",
              "pages_manage_engagement", "pages_read_engagement", "pages_manage_metadata"]


def healthy():
    SCRIPT.clear()
    SCRIPT.update({
        "GET /app": {"id": "APP1", "name": "Zara Bot"},
        "GET /debug_token": {"data": {"is_valid": True, "app_id": "APP1", "scopes": list(ALL_SCOPES),
                                      "expires_at": 0}},
        "GET /APP1/subscriptions": json.loads(json.dumps(APP_SUBS)),
        "GET /P1/subscribed_apps": {"data": [{"id": "APP1", "subscribed_fields": ["messages", "feed"]}]},
        "GET /P1": {"instagram_business_account": {"id": "IG1"}},
    })


def report():
    r = client.post("/api/v1/portal/instagram/setup-check")
    body = r.get_json() or {}
    return r, {c["id"]: c for c in body.get("checks", [])}, body


healthy()
seen.clear()
r, checks, body = report()
check("healthy setup: every verifiable step ok, review marked manual",
      r.status_code == 200 and all(checks[k]["status"] == "ok" for k in (
          "saved", "provider", "app", "token_ig", "token_page", "app_webhook", "page_subscribed",
          "ig_link", "webhook_seen", "sending")) and checks["review"]["status"] == "manual",
      {k: (v["status"], v["detail"][:80]) for k, v in checks.items()})
check("report names the webhook URL and the app; no secret leaves the CP",
      body["webhookUrl"] == "https://cp.example.com/api/v1/public/meta/webhook"
      and body["app"] == {"id": "APP1", "name": "Zara Bot"}
      and not any(s in r.get_data(as_text=True) for s in ("app-sec", "ig-tok", "page-tok")))
check("debug_token read with the app token (app_id|secret)",
      any(s[1].startswith("/debug_token") and s[2] == "APP1|app-sec" for s in seen))
check("the check only reads (no POST to Meta)", all(s[0] == "GET" for s in seen))
check("sending step says the laptop bridge is no longer needed",
      "no longer needed" in checks["sending"]["detail"])

SCRIPT["GET /debug_token"] = {"data": {"is_valid": True, "app_id": "APP1", "expires_at": 0,
                                       "scopes": [s for s in ALL_SCOPES if s != "pages_messaging"]}}
r, checks, body = report()
check("missing permission named on the token that needs it",
      checks["token_page"]["status"] == "fail" and "pages_messaging" in checks["token_page"]["detail"]
      and checks["token_ig"]["status"] == "ok", checks["token_page"])
SCRIPT["GET /debug_token"] = {"data": {"is_valid": True, "app_id": "APP1", "expires_at": 0, "scopes": [
    "instagram_business_manage_messages", "instagram_business_manage_comments"] + ALL_SCOPES[2:]}}
r, checks, body = report()
check("Instagram-Login scope names count as granted", checks["token_ig"]["status"] == "ok", checks["token_ig"])
SCRIPT["GET /debug_token"] = {"data": {"is_valid": True, "app_id": "APP1", "scopes": ALL_SCOPES,
                                       "expires_at": int(time.time()) + 3 * 86400}}
r, checks, body = report()
check("token expiring within a week -> warning", checks["token_ig"]["status"] == "warn"
      and "expires in" in checks["token_ig"]["detail"])
SCRIPT["GET /debug_token"] = {"data": {"is_valid": False, "app_id": "APP1", "scopes": []}}
r, checks, body = report()
check("invalid token -> fail", checks["token_ig"]["status"] == "fail"
      and "no longer valid" in checks["token_ig"]["detail"])
SCRIPT["GET /debug_token"] = {"data": {"is_valid": True, "app_id": "OTHER", "scopes": ALL_SCOPES}}
r, checks, body = report()
check("token from another app -> fail", "different Meta app" in checks["token_ig"]["detail"])

healthy()
SCRIPT["GET /APP1/subscriptions"] = {"data": [APP_SUBS["data"][0]]}
SCRIPT["GET /P1/subscribed_apps"] = {"data": []}
r, checks, body = report()
check("missing Page webhook -> fail with the subscribe_app fix",
      checks["app_webhook"]["status"] == "fail" and checks["app_webhook"]["fix"] == "subscribe_app"
      and "Page webhook is not set up" in checks["app_webhook"]["detail"], checks["app_webhook"])
check("Page without the app -> fail with the subscribe_page fix",
      checks["page_subscribed"]["status"] == "fail" and checks["page_subscribed"]["fix"] == "subscribe_page")
subs = json.loads(json.dumps(APP_SUBS))
subs["data"][0]["callback_url"] = "https://old-laptop.ngrok.io/hook"
subs["data"][1]["fields"] = [{"name": "messages"}]
SCRIPT["GET /APP1/subscriptions"] = subs
SCRIPT["GET /P1/subscribed_apps"] = {"data": [{"id": "APP1", "subscribed_fields": ["messages"]}]}
r, checks, body = report()
check("webhook pointing elsewhere / lacking fields is spelled out",
      "points to https://old-laptop.ngrok.io/hook" in checks["app_webhook"]["detail"]
      and "Page webhook lacks feed" in checks["app_webhook"]["detail"], checks["app_webhook"]["detail"])
check("Page subscription lacking feed -> fixable", checks["page_subscribed"]["fix"] == "subscribe_page"
      and "lacks feed" in checks["page_subscribed"]["detail"])
SCRIPT["GET /P1"] = {"instagram_business_account": {"id": "IG-OTHER"}}
r, checks, body = report()
check("Page linked to another Instagram account -> fail", checks["ig_link"]["status"] == "fail"
      and "IG-OTHER" in checks["ig_link"]["detail"])

healthy()
SCRIPT["GET /app"] = IG.MetaGraphError(400, "Invalid OAuth access token.")
r, checks, body = report()
check("Meta refuses the token -> app fail, dependent steps skipped (no crash)",
      r.status_code == 200 and checks["app"]["status"] == "fail"
      and checks["token_ig"]["status"] == "skip" and checks["app_webhook"]["status"] == "skip",
      {k: v["status"] for k, v in checks.items()})

print("== setup fixes ==")
healthy()
SCRIPT["GET /APP1/subscriptions"] = {"data": [{"object": "instagram", "callback_url": "x", "active": True,
                                              "fields": [{"name": "mentions"}]}]}
SCRIPT["POST /P1/subscribed_apps"] = {"success": True}
SCRIPT["POST /APP1/subscriptions"] = {"success": True}
seen.clear()
r = client.post("/api/v1/portal/instagram/setup-fix", json={"fix": "subscribe_page"})
post_calls = [s for s in seen if s[0] == "POST"]
check("subscribe_page: Page subscribed with the needed fields, Page token",
      r.status_code == 200 and len(post_calls) == 1
      and post_calls[0][1] == "/P1/subscribed_apps?subscribed_fields=messages,feed"
      and post_calls[0][2] == "page-tok" and "Page subscribed" in r.get_json()["note"]
      and "checks" in r.get_json(), (r.get_data(as_text=True)[:200], post_calls))
seen.clear()
r = client.post("/api/v1/portal/instagram/setup-fix", json={"fix": "subscribe_app"})
post_calls = [s for s in seen if s[0] == "POST"]
from urllib.parse import parse_qs, urlsplit  # noqa: E402
q = [parse_qs(urlsplit(p[1]).query) for p in post_calls]
check("subscribe_app: both webhooks registered at this CP with the app token",
      r.status_code == 200 and [p[1].split("?")[0] for p in post_calls] == ["/APP1/subscriptions"] * 2
      and all(p[2] == "APP1|app-sec" for p in post_calls)
      and [x["object"][0] for x in q] == ["instagram", "page"]
      and all(x["callback_url"][0] == "https://cp.example.com/api/v1/public/meta/webhook"
              and x["verify_token"][0] == "ver-1" for x in q), (r.get_data(as_text=True)[:200], q))
check("existing webhook fields are kept (merged, never narrowed)",
      q[0]["fields"][0] == "mentions,messages,comments" and q[1]["fields"][0] == "messages,feed", q)
logged = sql("SELECT action, note FROM portal_action_log WHERE client_id = 1"
             " AND action = 'instagram.setup_fix' ORDER BY id")
check("each fix is audited", len(logged) == 2, logged)
check("fix response leaks no secret", not any(s in r.get_data(as_text=True) for s in ("app-sec", "page-tok")))
SCRIPT["POST /P1/subscribed_apps"] = {"success": False}
r = client.post("/api/v1/portal/instagram/setup-fix", json={"fix": "subscribe_page"})
check("Meta does not confirm -> 502 with a plain reason", r.status_code == 502
      and "did not confirm" in r.get_json()["error"]["message"])
SCRIPT["POST /APP1/subscriptions"] = IG.MetaGraphError(400, "(#2200) Callback verification failed.")
r = client.post("/api/v1/portal/instagram/setup-fix", json={"fix": "subscribe_app"})
check("Meta error passed through (502)", r.status_code == 502
      and "Callback verification failed" in r.get_json()["error"]["message"])
r = client.post("/api/v1/portal/instagram/setup-fix", json={"fix": "delete_everything"})
check("unknown fix -> 400", r.status_code == 400)
base = os.environ.pop("OMNIFLOW_TWILIO_WEBHOOK_BASE")
import portal_voice  # noqa: E402
real_panel = portal_voice._panel_webhook_base
portal_voice._panel_webhook_base = lambda: ""
seen.clear()
r = client.post("/api/v1/portal/instagram/setup-fix", json={"fix": "subscribe_app"},
                base_url="http://localhost")
check("no public CP URL -> subscribe_app refused (409), nothing sent to Meta",
      r.status_code == 409 and not [s for s in seen if s[0] == "POST"], r.get_data(as_text=True)[:200])
os.environ["OMNIFLOW_TWILIO_WEBHOOK_BASE"] = base
portal_voice._panel_webhook_base = real_panel

stub.principal = human_principal(client_id=5, user_id=51)
r, checks, body = report()
check("empty workspace: only 'Settings saved' (fail), no Graph calls needed",
      r.status_code == 200 and list(checks) == ["saved"] and checks["saved"]["status"] == "fail")
r = client.post("/api/v1/portal/instagram/setup-fix", json={"fix": "subscribe_page"})
check("fix without a Page -> 409", r.status_code == 409)
stub.principal = None
check("signed-out -> 401", client.post("/api/v1/portal/instagram/setup-check").status_code == 401)
stub.principal = OWNER

stub.restore()
server.cleanup()
web()
sys.exit(1 if summary("meta_cp_send") else 0)
