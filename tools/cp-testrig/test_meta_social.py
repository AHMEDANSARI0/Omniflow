"""§228 Meta social - Messenger + Instagram / Facebook comments.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
Units for the normalizers, routing and validation; then the real routes on
`pgserver` (PostgreSQL 16): migration of an old settings table, settings,
page ownership, Meta verify, the signed webhook through the REAL shared
ingest core, comment memory, and the dispatch routing / comment policy with
a stubbed Graph call. The database half is skipped when pgserver is missing.
"""
import hashlib
import hmac
import json
import os
import re
import sys

from test_lib import check, summary, human_principal, PrincipalStub

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.pop("OF_INSTAGRAM_APP_SECRET", None)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
ROOT = os.path.abspath(os.path.join(os.getcwd(), ".."))

import connector_api  # noqa: E402
import portal_channels  # noqa: E402
import portal_instagram as IG  # noqa: E402

# ---------------------------------------------------------------------------
# units
# ---------------------------------------------------------------------------
print("== normalizers ==")
page_payload = {"object": "page", "entry": [{
    "id": "P1",
    "messaging": [
        {"sender": {"id": "PSID9"}, "recipient": {"id": "P1"},
         "message": {"mid": "m.fb.1", "text": "Price kya hai?"}},
        {"sender": {"id": "P1"}, "recipient": {"id": "PSID9"},
         "message": {"mid": "m.echo", "text": "echo", "is_echo": True}},
    ],
    "changes": [
        {"field": "feed", "value": {"item": "comment", "verb": "add", "comment_id": "P1_c1",
                                    "post_id": "P1_post", "message": "Delivery Lahore?",
                                    "from": {"id": "U1", "name": "Bilal"}}},
        {"field": "feed", "value": {"item": "comment", "verb": "add", "comment_id": "P1_c2",
                                    "post_id": "P1_post", "message": "Our own reply",
                                    "from": {"id": "P1", "name": "Shop"}}},
        {"field": "feed", "value": {"item": "comment", "verb": "edited", "comment_id": "P1_c3",
                                    "message": "edit", "from": {"id": "U1"}}},
        {"field": "feed", "value": {"item": "reaction", "verb": "add", "from": {"id": "U1"}}},
    ],
}]}
msgr = IG.normalize_messenger_events(page_payload, page_id="P1")
check("Messenger DM -> fb: contact, messenger channel, echo skipped",
      len(msgr) == 1 and msgr[0]["from"] == "fb:PSID9" and msgr[0]["channel"] == "messenger"
      and msgr[0]["provider"] == "meta_messenger" and msgr[0]["id"] == "m.fb.1", msgr)
fbc = IG.normalize_comment_events(page_payload, "P1", "facebook")
check("FB comment -> fbc: contact; own / edited / reactions skipped",
      len(fbc) == 1 and fbc[0]["from"] == "fbc:U1" and fbc[0]["id"] == "comment:P1_c1"
      and fbc[0]["comment"] == {"id": "P1_c1", "platform": "facebook", "post_id": "P1_post"}
      and fbc[0]["name"] == "Bilal", fbc)
check("Instagram DM normalizer unchanged (ig:)",
      IG.normalize_instagram_events({"object": "instagram", "entry": [{"id": "IG1", "messaging": [
          {"sender": {"id": "S1"}, "recipient": {"id": "IG1"},
           "message": {"mid": "m1", "text": "hi"}}]}]})[0]["from"] == "ig:S1")
ig_payload = {"object": "instagram", "entry": [{"id": "IG1", "changes": [
    {"field": "comments", "value": {"id": "17c1", "text": "Size M hai?",
                                    "from": {"id": "IGU1", "username": "sana"},
                                    "media": {"id": "MEDIA1"}}},
    {"field": "comments", "value": {"id": "17c2", "text": "Thanks!",
                                    "from": {"id": "IG1", "username": "shop"}}},
    {"field": "mentions", "value": {"id": "x", "text": "y", "from": {"id": "Z"}}},
]}]}
igc = IG.normalize_comment_events(ig_payload, "IG1", "instagram")
check("IG comment -> igc: contact, own reply skipped, other fields ignored",
      len(igc) == 1 and igc[0]["from"] == "igc:IGU1" and igc[0]["channel"] == "instagram"
      and igc[0]["comment"]["post_id"] == "MEDIA1" and igc[0]["name"] == "sana", igc)
check("comments for another account are ignored",
      IG.normalize_comment_events(ig_payload, "IG-OTHER", "instagram") == [])

print("== routing + validation ==")
check("channel_for_contact: igc/ig -> instagram, fb/fbc -> messenger, others unchanged",
      [portal_channels.channel_for_contact(c) for c in
       ("igc:1", "ig:1", "fb:1", "fbc:1", "tg:1", "923001234567")]
      == ["instagram", "instagram", "messenger", "messenger", "telegram", "whatsapp"])
check("messenger is an ingest channel", "messenger" in connector_api.ALLOWED_CHANNELS)
check("recipient prefix unwrapped for fb:", IG._target_id("fb:PSID9") == "PSID9"
      and IG._target_id("ig:1") == "1")
base = {"page_id": "P1", "access_token": "tok", "app_secret": "sec", "verify_token": "ver"}
clean, err = IG._clean_settings(dict(base, messenger_enabled=True))
check("page-only Messenger config is valid", err is None and clean["messenger_enabled"], err)
_, err = IG._clean_settings({"access_token": "t", "app_secret": "s", "verify_token": "v",
                             "messenger_enabled": True})
check("Messenger without a Page ID is refused", err == "Messenger needs the Facebook Page ID.", err)
_, err = IG._clean_settings({"page_id": "P1", "app_secret": "s", "verify_token": "v",
                             "messenger_enabled": True})
check("Messenger without any token is refused", err == "Messenger needs a Page access token.", err)
_, err = IG._clean_settings({"page_id": "P1", "access_token": "t", "app_secret": "s"})
check("a Page needs the webhook verify token", err == "A webhook verify token is required.", err)
_, err = IG._clean_settings({"page_id": "P1", "access_token": "t", "verify_token": "v"})
check("a Page needs the app secret (signed webhooks)", err and "App secret" in err, err)
clean, _ = IG._clean_settings(dict(base, comment_auto_reply=True))
check("comment auto-reply cannot be on while comments are off",
      clean["comment_auto_reply"] is False)
check("page token falls back to the access token",
      IG.page_token({"access_token": "A"}) == "A"
      and IG.page_token({"access_token": "A", "page_access_token": "P"}) == "P")


def web():
    print("== website pins ==")

    def read(rel):
        return open(os.path.join(ROOT, rel), encoding="utf-8").read()

    card = read("app/dashboard/(portal)/settings/InstagramCard.tsx")
    check("settings card: Messenger, comments, AI comments switch, webhook path",
          all(s in card for s in ("Facebook Messenger", "Comments on posts", "AI answers comments",
                                  "page_access_token", "comment_auto_reply", "webhookPath")))
    check("coming-soon channels come from the integrations list",
          "INTEGRATIONS.filter(" in card and 'item.status === "soon"' in card)
    integ = read("lib/marketing/integrations.ts")
    check("Messenger early access; YouTube / LinkedIn / X coming soon (TikTok kept)",
          all('id: "' + i + '"' in integ for i in ("youtube", "linkedin", "x", "tiktok"))
          and 'status: "beta",\n    description:\n      "Facebook Page messages' in integ)
    inbox = read("app/dashboard/(portal)/conversations/InboxClient.tsx")
    check("inbox: messenger filter + comment marker",
          re.search(r'INBOX_CHANNELS = \[\s*"whatsapp",\s*"instagram",\s*"messenger",', inbox)
          and '(["all", ...INBOX_CHANNELS] as const)' in inbox
          and "(igc|fbc|" in inbox)
    portal = read("lib/omniflow/portal.ts")
    check("portal.ts: settings fields + real CP messages",
          all(s in portal for s in ("messengerEnabled: boolean;", "comment_auto_reply: input.commentAutoReply",
                                    "providerError", "{ invalid: string }")))
    route = read("app/api/omniflow/portal/instagram/settings/route.ts")
    check("BFF passes the new switches and the CP message",
          "comment_auto_reply === true" in route and "result.invalid" in route)
    bridge = read("connector-node/instagram_bridge.py")
    check("laptop bridge polls Instagram and Messenger", 'CHANNELS = ("instagram", "messenger")' in bridge)
    for rel, text in (("InstagramCard.tsx", card),):
        bad = [ch for ch in text if ord(ch) in (0x25B6, 0x261D, 0x2714, 0x26A1, 0x2699, 0x2709,
                                                 0x260E, 0x2733, 0x263A, 0x25FC, 0x27A1)]
        check("icon law: " + rel, bad == [], bad)


try:
    import pgserver
    import psycopg2
except Exception:
    pgserver = None

if pgserver is None:
    print("  skip: pgserver not installed - database half not run")
    web()
    sys.exit(1 if summary("meta_social") else 0)

# ---------------------------------------------------------------------------
# real PostgreSQL
# ---------------------------------------------------------------------------
print("== Meta social on real PostgreSQL ==")
import tempfile  # noqa: E402

data_dir = tempfile.mkdtemp(prefix="of_meta_pg_")
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

# a deployment from before §228: old columns only, one connected workspace
sql("CREATE TABLE portal_instagram_accounts (client_id BIGINT PRIMARY KEY,"
    " instagram_account_id TEXT NOT NULL DEFAULT '', page_id TEXT NOT NULL DEFAULT '',"
    " app_secret TEXT NOT NULL DEFAULT '', access_token TEXT NOT NULL DEFAULT '',"
    " verify_token TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT FALSE,"
    " last_check_at TIMESTAMPTZ, last_error TEXT,"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())", fetch=False)
sql("INSERT INTO portal_instagram_accounts (client_id, instagram_account_id, app_secret,"
    " access_token, verify_token, enabled) VALUES (3, 'IG-OLD', 'old-sec', 'old-tok', 'old-ver', TRUE)",
    fetch=False)
IG._DDL_READY = False
_c = portal_db._conn()
IG._ensure_instagram_tables(_c)
_c.close()
cols = {r[0] for r in sql("SELECT column_name FROM information_schema.columns"
                          " WHERE table_name = 'portal_instagram_accounts'")}
check("old table gains the new columns", {"page_access_token", "messenger_enabled",
                                           "comments_enabled", "comment_auto_reply"} <= cols, cols)
old = one("SELECT instagram_account_id, access_token, enabled, messenger_enabled,"
          " comments_enabled, comment_auto_reply FROM portal_instagram_accounts WHERE client_id = 3")
check("existing workspace untouched; new switches off", old == ("IG-OLD", "old-tok", True,
                                                                  False, False, False), old)
IG._DDL_READY = False
_c = portal_db._conn()
IG._ensure_instagram_tables(_c)  # second run: nothing to add, no error
_c.close()
check("comments table exists", one("SELECT to_regclass('portal_meta_comments')")[0] is not None)

OWNER = human_principal(client_id=1, user_id=11)
app = Flask("meta_social_test")
app.register_blueprint(IG.bp)
app.register_blueprint(IG.public_bp)
app.register_blueprint(IG.connector_bp)
app.register_blueprint(connector_api.bp)
client = app.test_client()
stub = PrincipalStub(IG, OWNER)
SVC = {"X-Omniflow-Key": os.environ["OMNIFLOW_SERVICE_KEY"]}

r = client.put("/api/v1/portal/instagram/settings", json={
    "enabled": True, "page_id": "P1", "access_token": "page-tok", "app_secret": "app-sec",
    "verify_token": "ver-1", "messenger_enabled": True, "comments_enabled": True})
check("page-only save (Messenger + comments)", r.status_code == 200, r.get_data(as_text=True)[:300])
got = client.get("/api/v1/portal/instagram/settings").get_json()["settings"]
check("settings read back", got["messengerEnabled"] and got["commentsEnabled"]
      and not got["commentAutoReply"] and got["configured"] and not got["enabled"]
      and got["webhookPath"] == "/api/v1/public/meta/webhook", got)
r = client.put("/api/v1/portal/instagram/settings", json={"page_id": "", "messenger_enabled": True})
check("validation message from the CP (400)", r.status_code == 400
      and r.get_json()["error"]["message"] == "Messenger needs the Facebook Page ID.",
      r.get_data(as_text=True)[:200])
check("a refused save changes nothing", client.get("/api/v1/portal/instagram/settings")
      .get_json()["settings"]["commentsEnabled"] is True)
stub.principal = human_principal(client_id=2, user_id=21)
r = client.put("/api/v1/portal/instagram/settings", json={
    "page_id": "P1", "access_token": "x", "app_secret": "y", "verify_token": "z"})
check("another workspace cannot take the same Page (409)", r.status_code == 409
      and r.get_json()["error"]["code"] == "page_taken", r.get_data(as_text=True)[:200])
stub.principal = OWNER

seen = []


def fake_meta(method, path, token, payload=None):
    seen.append((method, path, token, payload))
    if path.startswith("/P1?"):
        return {"id": "P1", "name": "Zara Threads"}
    if path.startswith("/IG1?"):
        return {"id": "IG1", "username": "zara.threads"}
    if path == "/BOOM/messages":
        raise IG.MetaGraphError(400, "(#10) Outside the allowed window.")
    return {"message_id": "mid.out", "id": "c.out"}


IG._meta_request = fake_meta
r = client.post("/api/v1/portal/instagram/test")
check("verify a Page-only connection", r.status_code == 200
      and r.get_json()["page"] == {"id": "P1", "name": "Zara Threads"}, r.get_data(as_text=True)[:200])
check("verified with the Page token", seen[-1][2] == "page-tok" and seen[-1][1] == "/P1?fields=id,name")

r = client.get("/api/v1/public/meta/webhook?hub.mode=subscribe&hub.verify_token=ver-1&hub.challenge=c42")
check("Meta URL verification works for a Page-only workspace", r.status_code == 200 and r.data == b"c42",
      r.status_code)
r = client.get("/api/v1/public/instagram/webhook?hub.mode=subscribe&hub.verify_token=old-ver&hub.challenge=c7")
check("old Instagram URL still verifies", r.status_code == 200 and r.data == b"c7")


def post(path, payload, secret="app-sec"):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return client.post(path, data=raw, headers={"Content-Type": "application/json",
                                                "X-Hub-Signature-256": sig})


r = post("/api/v1/public/meta/webhook", page_payload, secret="wrong")
check("bad signature -> 403", r.status_code == 403)
r = post("/api/v1/public/meta/webhook", dict(page_payload, object="whatsapp_business_account"))
check("other Meta objects -> 400", r.status_code == 400)
r = post("/api/v1/public/meta/webhook", {"object": "page", "entry": [{"id": "P-UNKNOWN", "messaging": []}]})
check("unknown Page -> 404", r.status_code == 404)
r = post("/api/v1/public/meta/webhook", page_payload)
check("signed Page webhook -> DM + comment through the shared core", r.status_code == 200
      and r.get_json()["inserted"] == 2, r.get_data(as_text=True)[:300])
convs = sql("SELECT channel, contact_id, contact_name FROM portal_conversations WHERE client_id = 1 ORDER BY id")
check("conversations: Messenger DM and Facebook comment, separate",
      [tuple(c) for c in convs] == [("messenger", "fb:PSID9", None), ("messenger", "fbc:U1", "Bilal")], convs)
check("comment remembered for the reply; own comment not stored",
      sql("SELECT contact_id, comment_id, platform, post_id FROM portal_meta_comments ORDER BY id")
      == [("fbc:U1", "P1_c1", "facebook", "P1_post")])
r = post("/api/v1/public/meta/webhook", page_payload)
check("replayed delivery stores nothing twice",
      one("SELECT COUNT(*) FROM portal_messages WHERE client_id = 1")[0] == 2
      and one("SELECT COUNT(*) FROM portal_meta_comments")[0] == 1, r.get_json())

sql("UPDATE portal_instagram_accounts SET instagram_account_id = 'IG1' WHERE client_id = 1", fetch=False)
r = post("/api/v1/public/instagram/webhook", ig_payload)
check("Instagram comment via the old URL -> igc: conversation", r.status_code == 200
      and r.get_json()["inserted"] == 1
      and one("SELECT channel FROM portal_conversations WHERE contact_id = 'igc:IGU1'") == ("instagram",),
      r.get_data(as_text=True)[:200])
sql("UPDATE portal_instagram_accounts SET messenger_enabled = FALSE WHERE client_id = 1", fetch=False)
msg_only = {"object": "page", "entry": [{"id": "P1", "messaging": [
    {"sender": {"id": "PSID5"}, "recipient": {"id": "P1"}, "message": {"mid": "m.off", "text": "x"}}]}]}
r = post("/api/v1/public/meta/webhook", msg_only)
check("Messenger switched off -> Page DMs are not taken in", r.status_code == 200
      and r.get_json()["inserted"] == 0)
sql("UPDATE portal_instagram_accounts SET messenger_enabled = TRUE WHERE client_id = 1", fetch=False)

r = client.get("/api/v1/connector/whatsapp/commands?client_id=1&channel=messenger", headers=SVC)
# §256: the Control Plane sends Meta replies itself - a bridge poll for
# channel=messenger is refused (OF_META_CP_SEND=0 would accept it again)
check("connector queue refuses channel=messenger (CP sends Meta, §256)", r.status_code == 400, r.get_data(as_text=True)[:200])


def command(contact, source="manual", action="send_message", body="Ji, 3 din mein.", channel=None):
    payload = {"external_user_id": contact, "body": body, "source": source}
    if action == "send_media":
        payload.update(media_url="https://cdn.example/a.jpg", kind="image")
    return one("INSERT INTO portal_connector_commands (client_id, action, payload, status, channel)"
               " VALUES (1, %s, %s, 'pending', %s) RETURNING id",
               (action, json.dumps(payload), channel or portal_channels.channel_for_contact(contact)))[0]


def dispatch(cid):
    return client.post("/api/v1/connector/instagram/commands/dispatch", headers=SVC,
                       json={"client_id": 1, "command_id": cid})


def status(cid):
    return one("SELECT status FROM portal_connector_commands WHERE id = %s", (cid,))[0]


seen.clear()
cid = command("fb:PSID9")
r = dispatch(cid)
check("Messenger reply -> /{page}/messages with the Page token", r.status_code == 200
      and seen[-1][1] == "/P1/messages" and seen[-1][2] == "page-tok"
      and seen[-1][3]["recipient"] == {"id": "PSID9"} and seen[-1][3]["messaging_type"] == "RESPONSE"
      and status(cid) == "done", (r.get_data(as_text=True)[:200], seen[-1:]))
cid = command("fbc:U1")
r = dispatch(cid)
check("Facebook comment reply -> public reply under the latest comment", r.status_code == 200
      and seen[-1][1] == "/P1_c1/comments" and seen[-1][3] == {"message": "Ji, 3 din mein."}
      and status(cid) == "done", seen[-1:])
cid = command("igc:IGU1", source="approval")
r = dispatch(cid)
check("Instagram comment reply (owner-approved) -> /{comment}/replies", r.status_code == 200
      and seen[-1][1] == "/17c1/replies" and seen[-1][2] == "page-tok", seen[-1:])
cid = command("ig:S1")
r = dispatch(cid)
check("Instagram DM routing unchanged", r.status_code == 200 and seen[-1][1] == "/IG1/messages")

n = len(seen)
cid = command("fbc:U1", source="sequence")
r = dispatch(cid)
check("automation (sequence) never posts a public comment: refused, final",
      r.status_code == 409 and r.get_json()["error"]["code"] == "refused" and len(seen) == n
      and status(cid) == "dead", r.get_data(as_text=True)[:200])
cid = command("igc:IGU1", source="ai_brain")
r = dispatch(cid)
check("AI comment reply refused while comment auto-reply is off", r.status_code == 409 and len(seen) == n)
cid = command("fbc:U1", action="send_media")
r = dispatch(cid)
check("media to a comment refused", r.status_code == 409
      and "text replies only" in r.get_json()["error"]["message"])
cid = command("fbc:NOBODY")
r = dispatch(cid)
check("no comment to reply to -> refused", r.status_code == 409
      and "No comment" in r.get_json()["error"]["message"])
r = dispatch(cid)
check("a dead command is not sent again", r.status_code == 200 and r.get_json()["status"] == "dead"
      and len(seen) == n)
sql("UPDATE portal_instagram_accounts SET comment_auto_reply = TRUE WHERE client_id = 1", fetch=False)
cid = command("igc:IGU1", source="ai_brain")
r = dispatch(cid)
check("AI comment reply allowed once the owner turns it on", r.status_code == 200
      and seen[-1][1] == "/17c1/replies")
sql("UPDATE portal_instagram_accounts SET messenger_enabled = FALSE WHERE client_id = 1", fetch=False)
n = len(seen)
cid = command("fb:PSID9")
r = dispatch(cid)
check("Messenger off -> DM refused, not sent", r.status_code == 409 and len(seen) == n
      and status(cid) == "dead")
sql("UPDATE portal_instagram_accounts SET messenger_enabled = TRUE, page_id = 'BOOM' WHERE client_id = 1",
    fetch=False)
cid = command("fb:PSID9")
r = dispatch(cid)
check("Meta error -> 502 with Meta's reason, command stays for retry", r.status_code == 502
      and "allowed window" in r.get_json()["error"]["message"] and status(cid) == "pending",
      r.get_data(as_text=True)[:200])
sql("UPDATE portal_instagram_accounts SET page_id = 'P1' WHERE client_id = 1", fetch=False)

print("== brain gate ==")
import portal_brain  # noqa: E402

calls = []
real = (portal_brain._ensure_ddl, portal_brain._load_settings, portal_brain._reason)
portal_brain._ensure_ddl = lambda cur: None
portal_brain._load_settings = lambda cur, cid: {"autonomy": "auto"}


def no_reason(*args, **kwargs):
    calls.append(args[3])
    raise RuntimeError("stop after the gate")


portal_brain._reason = no_reason
sql("UPDATE portal_instagram_accounts SET comment_auto_reply = FALSE WHERE client_id = 1", fetch=False)
_c = portal_db._conn()
portal_brain.maybe_answer(1, 1, "igc:IGU1", "sana", "Size M hai?", _c)
check("AI does not answer a comment while comment auto-reply is off", calls == [])
sql("UPDATE portal_instagram_accounts SET comment_auto_reply = TRUE WHERE client_id = 1", fetch=False)
portal_brain.maybe_answer(1, 1, "igc:IGU1", "sana", "Size M hai?", _c)
check("with comment auto-reply on, the brain runs", calls == ["igc:IGU1"])
portal_brain.maybe_answer(1, 1, "fb:PSID9", "", "Price?", _c)
check("Messenger DMs follow normal autonomy (no comment gate)", calls[-1] == "fb:PSID9")
_c.close()
portal_brain._ensure_ddl, portal_brain._load_settings, portal_brain._reason = real

stub.restore()
server.cleanup()
web()
sys.exit(1 if summary("meta_social") else 0)
