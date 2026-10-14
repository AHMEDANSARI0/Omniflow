"""§255 social channels (portal_social + connector wiring + login bridge).

Units: routing prefixes, capabilities per mode, truncation, provider error
classes (HTTP + TikTok codes), OAuth URLs (PKCE, LinkedIn page scopes),
redirect validation, X / TikTok webhook signatures and payload mapping
(own messages, other accounts, switched-off features), comment polling
cursors (first run imports nothing), the X paid check, settings cleaning,
the tick throttle, the laptop bridge's pure mappers, source pins (tick /
inbox kicks, bridge poll exclusions, brain gate, approvals kind, app wiring).
HTTP guards (401 / 503 / 403 API key / 403 non-editor / connector key).
Then the real thing on pgserver with a fake platform: keys sealed and
masked, OAuth start + finish (one-time state, foreign workspace, expiry),
X CRC + signed DMs and mentions through the shared ingest, replies sent by
the Control Plane (DM, comment reply, publish), public comment policy,
opt-outs, token refresh on 401, retry / refuse classes, YouTube and TikTok
comment polling, TikTok signed webhooks, posts with approvals (owner direct,
agent -> HIGH-risk approval, approve / reject), login mode (bridge command
filter with reply targets, away replies, ingest + heartbeat endpoints), the
personal Telegram channel kept away from the bot bridge, and isolation
between workspaces.
"""
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import sys
import tempfile
import time

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
os.environ["OF_PROACTIVE"] = "0"
for name in ("OF_SOCIAL_CHANNELS", "OF_SOCIAL_POLL_SECONDS", "OF_SOCIAL_MAX_SEND", "OF_LINKEDIN_VERSION",
             "OF_SOCIAL_TABLE", "OF_NOTIFY_ROLES", "OF_TIKTOK_SIG_TOLERANCE"):
    os.environ.pop(name, None)
BASE = "https://cp.example.com"
os.environ["OMNIFLOW_TWILIO_WEBHOOK_BASE"] = BASE
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_social as S  # noqa: E402
import portal_voice  # noqa: E402
import portal_channels  # noqa: E402
import connector_api  # noqa: E402
import portal_approvals  # noqa: E402
from portal_auth import PortalAuthUnavailable  # noqa: E402

HERE = os.getcwd()
portal_voice._panel_webhook_base = lambda: ""


def src(name):
    return open(os.path.join(HERE, name), encoding="utf8").read()


HTTP = {"calls": [], "fn": None}


def fake_transport(method, url, headers, body):
    parsed = json.loads(body.decode()) if body and headers.get("Content-Type") == "application/json" else (
        body.decode() if body else None)
    HTTP["calls"].append((method, url, dict(headers), parsed))
    if HTTP["fn"] is None:
        return 500, {}, {"error": "no responder"}
    return HTTP["fn"](method, url, headers, parsed)


S._transport = fake_transport

print("== config + routing ==")
check("defaults", (S.POLL_SECONDS, S.MAX_SEND_PER_RUN, S.DISPATCH_LIMIT, S.TABLE, S.ENABLED, S.LOCK_CLASS)
      == (120, 10, 3, "portal_social_accounts", True, 24402))
check("five channels", S.CHANNELS == ("tiktok", "x", "linkedin", "youtube", "telegram_user"))
check("channel_for_contact: social prefixes; others unchanged",
      [portal_channels.channel_for_contact(c) for c in (
          "tt:c1", "ttc:u", "x:12", "XC:12", "li:2-a", "lic:p", "ytc:UC1", "tgu:55", "tg:55", "igc:1", "sms:+1", "9230")]
      == ["tiktok", "tiktok", "x", "x", "linkedin", "linkedin", "youtube", "telegram_user", "telegram", "instagram",
          "sms", "whatsapp"])
check("channel_of_contact / is_comment", [S.channel_of_contact(c) for c in ("x:1", "ytc:a", "923", "", None)]
      == ["x", "youtube", "", "", ""] and S.is_comment("lic:a") and not S.is_comment("li:a"))
check("ingest accepts the new channels; laptop bridges never get them unfiltered",
      all(c in connector_api.ALLOWED_CHANNELS for c in S.CHANNELS)
      and connector_api.SOCIAL_CHANNELS == S.CHANNELS
      and set(connector_api.SOCIAL_AWAY_PREFIXES) == set(S.PREFIXES)
      and connector_api.CP_DISPATCHED_CHANNELS == ("email", "sms", "instagram", "messenger"))


def acct(channel="x", mode="api", **flags):
    row = S._blank(7, channel)
    row.update(mode=mode, enabled=True, flags=dict(flags), access_token="tok", account_id="999")
    return row


check("has(): supported in the mode AND switched on",
      S.has(acct("x", dm=True), "dm") and not S.has(acct("x", dm=False), "dm")
      and not S.has(acct("linkedin", dm=True), "dm") and S.has(acct("linkedin", "login", dm=True), "dm")
      and not S.has(acct("youtube", publish=True), "publish") and not S.has(None, "dm"))
check("limits follow the mode: X API costs only in API mode, login warning only in login mode",
      any("paid per use" in l for l in S.limits_for("x", "api"))
      and not any("paid per use" in l or "webhook" in l for l in S.limits_for("x", "login"))
      and any("unofficial" in l for l in S.limits_for("x", "login"))
      and not any("unofficial" in l for l in S.limits_for("x", "api"))
      and all(S.limits_for(c, m) for c in S.CHANNELS for m in ("api", "login") if S.SPECS[c][m]))
check("fit: unchanged when short, ellipsis at the limit",
      S._fit("  hi ", 5) == "hi" and S._fit("a" * 300, 280) == "a" * 279 + "\u2026" and len(S._fit("b" * 9, 4)) == 4)
check("HTTP classes", [S._classify_status(c) for c in (401, 403, 400, 404, 429, 500, 503)]
      == ["auth", "final", "final", "final", "retry", "retry", "retry"])

print("== provider errors ==")


def respond(status, data, headers=None):
    HTTP["fn"] = lambda *a: (status, headers or {}, data)


for code, message, kind in ((40100, "Access token is invalid", "auth"), (40064, "rate", "retry"),
                            (50002, "busy", "retry"), (40001, "param error", "final")):
    respond(200, {"code": code, "message": message})
    try:
        S._tiktok("GET", "/business/get/", "t")
        got = None
    except S.SocialApiError as error:
        got = error.kind
    check("TikTok code %d -> %s" % (code, kind), got == kind, got)
respond(200, {"code": 0, "data": {"x": 1}})
check("TikTok ok -> data, Access-Token header", S._tiktok("GET", "/p", "tk") == {"x": 1}
      and HTTP["calls"][-1][2].get("Access-Token") == "tk")
respond(401, {"title": "Unauthorized", "detail": "Token expired"})
try:
    S._call("GET", "https://api.x.com/2/users/me", "t")
except S.SocialApiError as error:
    check("401 -> auth with the provider's message", error.kind == "auth" and error.message == "Token expired")


def boom(*a):
    raise OSError("dns")


HTTP["fn"] = boom
try:
    S._call("GET", "https://x", "t")
except S.SocialApiError as error:
    check("network failure -> retry without internals", error.kind == "retry" and "dns" not in error.message)

print("== OAuth URLs + redirect ==")
x_url = S.authorize_url(dict(acct("x"), app_id="cid"), "https://site/r", "st", "ch")
check("X: PKCE S256, scopes incl. dm + offline", "code_challenge=ch" in x_url and "S256" in x_url
      and "dm.write" in x_url and "offline.access" in x_url and x_url.startswith("https://x.com/i/oauth2/authorize?"))
yt_url = S.authorize_url(dict(acct("youtube"), app_id="g"), "https://site/r", "st", "ch")
check("YouTube: offline consent + force-ssl", "access_type=offline" in yt_url and "prompt=consent" in yt_url
      and "youtube.force-ssl" in yt_url)
li = dict(acct("linkedin"), app_id="l")
check("LinkedIn: member scope, page scopes with an organization id",
      "w_organization_social" not in S.authorize_url(li, "https://s/r", "s", "c")
      and "w_organization_social" in S.authorize_url(dict(li, config={"organization_id": "5"}), "https://s/r", "s", "c"))
check("TikTok: client_key + comma scopes", "client_key=tk" in S.authorize_url(dict(acct("tiktok"), app_id="tk"),
                                                                            "https://s/r", "s", "c"))
CB = "https://shop.example.com/api/omniflow/portal/channels/social/callback"
check("redirect: https + our callback path only", S._redirect_ok(CB)
      and S._redirect_ok("http://localhost:3000/api/omniflow/portal/channels/social/callback")
      and not S._redirect_ok(CB.replace("https", "http")) and not S._redirect_ok(CB + "?x=1")
      and not S._redirect_ok("https://evil.example/other") and not S._redirect_ok("javascript:alert(1)"))
verifier, challenge = S._pkce()
check("PKCE pair", 43 <= len(verifier) <= 96 and challenge == base64.urlsafe_b64encode(
    hashlib.sha256(verifier.encode()).digest()).decode().rstrip("="))

print("== webhooks: signatures + mapping ==")
raw = b'{"a":1}'
good = "sha256=" + base64.b64encode(hmac.new(b"sec", raw, hashlib.sha256).digest()).decode()
check("X signature", S._signature_ok("sec", raw, good) and not S._signature_ok("other", raw, good)
      and not S._signature_ok("", raw, good) and not S._signature_ok("sec", raw, ""))
now = time.time()
tt_sig = "t=%d,s=%s" % (now, hmac.new(b"sec", str(int(now)).encode() + b"." + raw, hashlib.sha256).hexdigest())
check("TikTok signature: valid / stale / wrong secret / junk",
      S._tiktok_signature_ok("sec", raw, tt_sig, now) and not S._tiktok_signature_ok("sec", raw, tt_sig, now + 301)
      and not S._tiktok_signature_ok("no", raw, tt_sig, now) and not S._tiktok_signature_ok("sec", raw, "junk", now))
X_PAYLOAD = {"for_user_id": "999", "users": {"55": {"name": "Ali"}},
             "direct_message_events": [
                 {"type": "message_create", "id": "e1", "message_create": {"sender_id": "55", "message_data": {"text": "Price?"}}},
                 {"type": "message_create", "id": "e2", "message_create": {"sender_id": "999", "message_data": {"text": "own"}}}],
             "tweet_create_events": [
                 {"id_str": "t1", "text": "@shop hi", "user": {"id_str": "66", "name": "Sara"}},
                 {"id_str": "t2", "text": "mine", "user": {"id_str": "999"}},
                 {"id_str": "t3", "text": "RT", "user": {"id_str": "67"}, "retweeted_status": {}}]}
dms, comments = S.x_events(X_PAYLOAD, acct("x", dm=True, comments=True))
check("X: DM from the customer only (own skipped), with name + event id",
      dms == [{"from": "x:55", "body": "Price?", "direction": "in", "channel": "x", "name": "Ali",
               "provider": "social", "id": "x-dm:e1"}], dms)
check("X: mention from others only (own + retweets skipped)", [(c["contact"], c["comment_id"]) for c in comments]
      == [("xc:66", "t1")])
check("X: another account's payload / features off -> nothing",
      S.x_events(dict(X_PAYLOAD, for_user_id="1"), acct("x", dm=True, comments=True)) == ([], [])
      and S.x_events(X_PAYLOAD, acct("x")) == ([], []))
TT = {"event": "im_receive_msg", "content": json.dumps({"conversation_id": "cv1", "message_id": "m1",
                                                         "text": {"body": "Salam"}, "from_user": {"id": "u1"},
                                                         "to_user": {"id": "999"}})}
check("TikTok: inbound DM -> tt:<conversation>", S.tiktok_events(TT, acct("tiktok", dm=True))[0]["from"] == "tt:cv1"
      and S.tiktok_events(dict(TT, event="im_send_msg"), acct("tiktok", dm=True)) == []
      and S.tiktok_events(TT, acct("tiktok")) == []
      and S.tiktok_events(dict(TT, content="{bad"), acct("tiktok", dm=True)) == [])

print("== polling ==")
from datetime import datetime, timezone  # noqa: E402

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
yt = acct("youtube", comments=True)
HTTP["calls"].clear()
check("first run: cursor = now, nothing imported, no API call", S.poll_comments(yt, NOW) == []
      and yt["cursor"]["since"] == NOW.timestamp() and HTTP["calls"] == [])


def yt_threads(*a):
    def item(cid, author, at, text="Kab milega?"):
        return {"snippet": {"topLevelComment": {"id": cid, "snippet": {
            "authorChannelId": {"value": author}, "authorDisplayName": "N" + cid, "textOriginal": text,
            "videoId": "v1", "publishedAt": at}}}}
    return 200, {}, {"items": [item("c3", "UCa", "2026-10-08T12:05:00Z"), item("c2", "999", "2026-10-08T12:04:00Z"),
                               item("c1", "UCb", "2026-10-08T11:00:00Z")]}


HTTP["fn"] = yt_threads
got = S.poll_comments(yt, NOW)
check("YouTube: new comments only, own channel skipped, cursor advanced",
      [(c["contact"], c["comment_id"], c["post_id"]) for c in got] == [("ytc:UCa", "c3", "v1")]
      and yt["cursor"]["since"] > NOW.timestamp(), got)
check("YouTube: nothing new the second time", S.poll_comments(yt, NOW) == [])
check("LinkedIn without a page id: no comment polling", S.poll_comments(
    dict(acct("linkedin", comments=True), cursor={"since": 1}), NOW) == [])
xa = acct("x", dm=True, comments=True)


def x_reads(method, url, headers, body):
    if "/mentions" in url:
        return 200, {}, {"data": [{"id": "105", "author_id": "66", "text": "@shop?"}, {"id": "104", "author_id": "999"}],
                         "includes": {"users": [{"id": "66", "name": "Sara"}]}}
    return 200, {}, {"data": [{"id": "205", "sender_id": "55", "text": "hello"}, {"id": "204", "sender_id": "999"}]}


HTTP["fn"] = x_reads
check("X check, first run: stores newest ids, imports nothing", S.poll_x(xa) == ([], [])
      and xa["cursor"] == {"mention_id": "105", "dm_id": "205"}, xa["cursor"])
xa["cursor"] = {"mention_id": "100", "dm_id": "200"}
dms, mentions = S.poll_x(xa)
check("X check: newer DM + mention imported, own skipped, since_id sent",
      [d["from"] for d in dms] == ["x:55"] and [m["contact"] for m in mentions] == ["xc:66"]
      and any("since_id=100" in c[1] for c in HTTP["calls"]), (dms, mentions))

print("== settings cleaning ==")
blank = S._blank(7, "x")
for label, payload, needle in (("bad mode", {"mode": "web"}, "mode only"),
                               ("youtube login", {"mode": "login"}, None),
                               ("bad app id", {"app_id": "a b"}, "looks wrong"),
                               ("long secret", {"app_secret": "s" * 501}, "too long"),
                               ("flags not an object", {"flags": []}, "flags must"),
                               ("unknown flag", {"flags": {"boost": True}}, "Unknown"),
                               ("flag not bool", {"flags": {"dm": "yes"}}, "Unknown"),
                               ("enabled not bool", {"enabled": "1"}, "true or false")):
    channel = "youtube" if label == "youtube login" else "x"
    changes, problem = S._clean(channel, payload, S._blank(7, channel))
    check("clean refused: " + label, changes is None and (needle is None or needle in problem), problem)
changes, problem = S._clean("linkedin", {"flags": {"dm": True}}, S._blank(7, "linkedin"))
check("LinkedIn DMs refused in API mode", changes is None and "cannot do dm in api mode" in problem, problem)
changes, problem = S._clean("linkedin", {"organization_id": "12a"}, S._blank(7, "linkedin"))
check("LinkedIn page id must be a number", changes is None and "number" in problem)
saved = dict(blank, app_id="old", access_token="t", enabled=True)
changes, _ = S._clean("x", {"app_id": "new", "app_secret": "", "flags": {"dm": True}}, saved)
check("new app id clears the connection; blank secret keeps the saved one",
      changes["access_token"] == "" and changes["enabled"] is False and "app_secret" not in changes
      and changes["flags"] == {"dm": True}, changes)
changes, _ = S._clean("x", {"mode": "login"}, saved)
check("switching mode clears tokens and switches off", changes["mode"] == "login" and changes["access_token"] == ""
      and changes["enabled"] is False and changes["webhook_id"] == "")

print("== tick throttle ==")
started = []


class NoThread:
    def __init__(self, target=None, args=(), name="", daemon=False):
        started.append(args)

    def start(self):
        pass


real_thread = S.threading.Thread
S.threading.Thread = NoThread
first = S.kick(7)
check("kick: one run at a time", first is True and S.kick(7) is False and started == [(7,)])
S._RUNNING.clear()  # the run finished
check("kick: once per window even after the run finished", S.kick(7) is False and started == [(7,)])
S._LAST[7] -= S.POLL_SECONDS + 1
check("kick: again after the window", S.kick(7) is True and started == [(7,), (7,)])
check("kick: bad ids refused", S.kick(0) is False and S.kick("x") is False and S.kick(None) is False)
S._RUNNING.clear()
S.ENABLED = False
check("kick: platform switch off", S.kick(9) is False)
S.ENABLED = True
S.threading.Thread = real_thread
S._LAST.clear()
S._RUNNING.clear()

print("== login bridge helpers ==")
spec = importlib.util.spec_from_file_location(
    "social_login_bridge", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "connector-node",
                                        "social_login_bridge.py"))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)
check("bridge: channel map + target parsing", B.CP_CHANNEL == {"telegram": "telegram_user", "x": "x", "linkedin": "linkedin"}
      and B.target_of({"payload": {"external_user_id": "xc:66"}}, ("x:", "xc:")) == ("xc:", "66")
      and B.target_of({"payload": {"external_user_id": "x:"}}, ("x:",)) is None
      and B.target_of({"payload": {"external_user_id": "923"}}, ("x:",)) is None)
inbox = {"inbox_initial_state": {"users": {"55": {"name": "Ali"}}, "entries": [
    {"message": {"message_data": {"id": "12", "sender_id": "55", "text": "a"}}},
    {"message": {"message_data": {"id": "9", "sender_id": "55", "text": "old"}}},
    {"message": {"message_data": {"id": "13", "sender_id": "999", "text": "own"}}},
    {"conversation_read": {}}]}}
items, newest = B.x_dm_items(inbox, "999", 10)
check("bridge X DMs: newer only, own skipped, newest tracked",
      [i["id"] for i in items] == ["x-dm:12"] and items[0]["name"] == "Ali" and newest == 13, items)
glob_ = {"tweets": {"50": {"user_id_str": "66", "full_text": "@shop hi"}, "40": {"user_id_str": "66", "full_text": "old"},
                    "51": {"user_id_str": "999", "full_text": "mine"}}, "users": {"66": {"name": "Sara"}}}
items, newest = B.x_mention_items(glob_, "999", 45)
check("bridge X mentions -> comment items with the tweet to reply to",
      [(i["from"], i["comment_id"]) for i in items] == [("xc:66", "50")] and newest == 51, items)
convs = {"elements": [{"entityUrn": "urn:li:fs_conversation:2-abc", "events": [
    {"createdAt": 200, "entityUrn": "ev2", "from": {"com.linkedin.voyager.messaging.MessagingMember": {
        "miniProfile": {"firstName": "Bilal", "lastName": "K", "entityUrn": "urn:li:fs_miniProfile:B"}}},
     "eventContent": {"com.linkedin.voyager.messaging.event.MessageEvent": {"attributedBody": {"text": "Salam"}}}},
    {"createdAt": 300, "entityUrn": "ev3", "from": {"com.linkedin.voyager.messaging.MessagingMember": {
        "miniProfile": {"entityUrn": "urn:li:fs_miniProfile:ME"}}},
     "eventContent": {"com.linkedin.voyager.messaging.event.MessageEvent": {"attributedBody": {"text": "own"}}}}]}]}
items, newest = B.linkedin_items(convs, "urn:li:fs_miniProfile:ME", 100)
check("bridge LinkedIn: li:<conversation>, own skipped", [(i["from"], i["name"]) for i in items]
      == [("li:2-abc", "Bilal K")] and newest == 300, items)
BRIDGE = open(spec.origin, encoding="utf8").read()
check("bridge: polls its own channel, acks, never stores secrets in the CP",
      "commands?limit=20&channel=\" + cp_channel" in BRIDGE and "away-replies?limit=10&social=\" + cp_channel" in BRIDGE
      and "/api/v1/connector/social/messages" in BRIDGE and "/api/v1/connector/social/status" in BRIDGE
      and "X-Omniflow-Key" in BRIDGE and "UNOFFICIAL" in BRIDGE)

print("== wiring pins ==")
CONN = src("connector_api.py")
check("connector tick kicks social in its own guard",
      "                    import portal_social\n" in CONN and 'portal_social.kick(tenant["client_id"])' in CONN)
check("unfiltered poll excludes CP + social channels",
      "cmd_params.append(list(CP_DISPATCHED_CHANNELS + SOCIAL_CHANNELS))" in CONN)
check("channel poll filtered by portal_social", "found = portal_social.filter_bridge_commands(" in CONN)
check("away poll: social prefixes excluded by default, ?social= for the login bridge",
      "AND contact_id NOT LIKE ALL(%s)" in CONN and "portal_social.away_prefix(" in CONN)
check("identity map unchanged (no social identities)", '"em:": "email", "sms:": "phone"}' in CONN)
CONV = src("portal_conversations.py")
check("inbox: social filters + kick", '"tiktok", "x", "linkedin", "youtube", "telegram_user")' in CONV
      and 'portal_social.kick(principal.get("client_id"))' in CONV)
BRAIN = src("portal_brain.py")
check("brain: social comments only with comment auto-reply",
      'startswith(("ttc:", "xc:", "lic:", "ytc:"))' in BRAIN
      and "portal_social.comment_auto_reply(cur, client_id, str(contact_id))" in BRAIN)
check("approvals: social_post kind + resolver", ("social_post", "Social post") in portal_approvals.KINDS
      and portal_approvals._RESOLVERS.get("social_post") is S.resolve_post_approval)
check("dispatch_now hands social channels to portal_social", "portal_social.dispatch(client_id, channel)" in src(
    "portal_channels.py"))
APP = src("app.py")
check("app registers the three blueprints", all("aux_app.register_blueprint(" + b + ")" in APP for b in (
    "portal_social_bp", "portal_social_public_bp", "portal_social_connector_bp")))
MOD = src("portal_social.py")
check("secrets sealed via the vault", 'VAULT_FIELDS = ("app_secret", "consumer_secret", "bearer_token", "access_token",'
      in MOD and "portal_vault.seal(value" in MOD)

print("== HTTP guards ==")
app = Flask(__name__)
app.register_blueprint(S.bp)
app.register_blueprint(S.public_bp)
app.register_blueprint(S.connector_bp)
client = app.test_client()
URL = "/api/v1/portal/channels/social"
current_p = {"p": None, "exc": None}


def fake_auth():
    if current_p["exc"]:
        raise current_p["exc"]
    return current_p["p"]


S.authenticate_portal_request = fake_auth
real_conn = portal_db._conn
db_calls = []
portal_db._conn = lambda: db_calls.append(1) or (_ for _ in ()).throw(RuntimeError("db down"))
owner = {"client_id": 7, "user_id": 1, "role": "owner", "via_api_key": False}
check("no session -> 401", client.get(URL).status_code == 401 and client.put(URL + "/x", json={}).status_code == 401
      and client.post(URL + "/posts", json={}).status_code == 401)
current_p["exc"] = PortalAuthUnavailable("auth down")
check("auth unavailable -> 503", client.get(URL).status_code == 503)
current_p["exc"] = None
current_p["p"] = dict(owner, via_api_key=True)
check("API key -> 403", all(r.status_code == 403 for r in (
    client.get(URL), client.put(URL + "/x", json={"enabled": True}), client.post(URL + "/x/test"))))
current_p["p"] = dict(owner, role="agent")
check("non-editor: settings / OAuth / actions -> 403", all(r.status_code == 403 for r in (
    client.put(URL + "/x", json={"enabled": True}), client.post(URL + "/x/oauth/start", json={}),
    client.post(URL + "/oauth/finish", json={}), client.post(URL + "/x/sync"))))
current_p["p"] = owner
check("unknown channel / action -> 404", client.put(URL + "/myspace", json={}).status_code == 404
      and client.post(URL + "/x/explode").status_code == 404
      and client.post(URL + "/telegram_user/oauth/start", json={"redirect_uri": CB}).status_code == 404)
check("OAuth start: bad redirect -> 400", client.post(URL + "/x/oauth/start", json={"redirect_uri": "https://e/x"})
      .status_code == 400)
check("OAuth finish: missing code -> 400", client.post(URL + "/oauth/finish", json={"state": "s"}).status_code == 400)
check("posts: unknown channel -> 400", client.post(URL + "/posts", json={"channel": "fax"}).status_code == 400)
check("refused requests never reach the database", not db_calls)
r = client.get(URL)
check("database down -> 503 without internals", r.status_code == 503 and "db down" not in r.get_data(as_text=True))
check("connector routes need the service key", client.post("/api/v1/connector/social/status", json={}).status_code == 403
      and client.post("/api/v1/connector/social/messages", json={}).status_code == 403)
res = S.run(7)
check("run with the database down: never raises", res["reason"] == "unavailable" and not res["ran"], res)
portal_db._conn = real_conn


def run_db():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="social255_")
    server = pgserver.get_server(data, cleanup_mode="stop")  # noqa: F841
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()

    def sql(query, args=(), fetch=True):
        c = psycopg2.connect(host=data, dbname="postgres", user="postgres")
        try:
            cur = c.cursor()
            cur.execute(query, args)
            out = cur.fetchall() if fetch and cur.description else None
            c.commit()
            return out
        finally:
            c.close()

    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)
    import portal_events
    import portal_compliance
    import portal_brain
    c = portal_db._conn()
    with c.cursor() as cur:
        portal_events._ensure_ddl(cur)
        portal_approvals._ensure_ddl(cur)
    c.commit()
    portal_compliance._ensure_compliance_tables(c)
    c.commit()
    c.close()
    connector_api._ensure_away_table()
    portal_brain.maybe_answer = lambda *a, **k: None
    real_kick = S.kick
    S.kick = lambda cid: False

    r = client.get(URL)
    fresh = r.get_json()
    check("fresh db: GET lists the five channels, off, with honest limits",
          r.status_code == 200 and [c["channel"] for c in fresh["channels"]] == list(S.CHANNELS)
          and all(not c["enabled"] and not c["connected"] and c["limits"] for c in fresh["channels"])
          and fresh["posts"] == [] and fresh["can_edit"] is True, fresh)
    import re as _re
    TS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "lib", "omniflow", "portal.ts"),
              encoding="utf8").read()

    def ts_keys(name):
        block = TS.split("export interface " + name + " {", 1)[1].split("\n}", 1)[0]
        return set(_re.findall(r"(?m)^  ([a-z_]+)\??:", block))

    check("contract: channel keys == SocialChannelAccount", set(fresh["channels"][0]) == ts_keys("SocialChannelAccount"),
          set(fresh["channels"][0]) ^ ts_keys("SocialChannelAccount"))
    check("contract: state keys cover SocialChannelsState", ts_keys("SocialChannelsState") <= set(fresh), set(fresh))
    by = {c["channel"]: c for c in fresh["channels"]}
    check("modes: TikTok / YouTube API only, Telegram login only, X / LinkedIn both",
          by["tiktok"]["modes"] == ["api"] and by["youtube"]["modes"] == ["api"]
          and by["telegram_user"]["modes"] == ["login"] and by["telegram_user"]["mode"] == "login"
          and by["x"]["modes"] == ["api", "login"] and by["linkedin"]["capabilities"]["login"] == ["dm"])

    r = client.put(URL + "/x", json={"app_id": "cid", "app_secret": "csecret-12345", "bearer_token": "bearer-12345",
                                     "consumer_secret": "consumer-12345"})
    body = r.get_json()
    x_state = [c for c in body["channels"] if c["channel"] == "x"][0]
    check("keys saved, masked, write-only", r.status_code == 200 and x_state["app_id"] == "cid"
          and x_state["app_secret_masked"] == "****2345" and "csecret" not in json.dumps(body), x_state)
    stored = sql("SELECT app_secret, hook_key FROM portal_social_accounts WHERE client_id = 7 AND channel = 'x'")[0]
    check("hook key generated", len(stored[1]) >= 20)
    check("enable before connecting -> 409", client.put(URL + "/x", json={"enabled": True}).status_code == 409)
    check("keys audited", sql("SELECT COUNT(*) FROM portal_action_log WHERE client_id = 7"
                              " AND action = 'settings.social_channel'")[0][0] == 1)

    print("== OAuth ==")
    r = client.post(URL + "/x/oauth/start", json={"redirect_uri": CB})
    start_url = r.get_json()["url"]
    from urllib.parse import parse_qs, urlparse
    state = parse_qs(urlparse(start_url).query)["state"][0]
    check("start: authorize URL with a stored one-time state", r.status_code == 200 and "client_id=cid" in start_url
          and sql("SELECT client_id, channel, redirect_uri FROM portal_social_oauth WHERE state = %s", (state,))
          == [(7, "x", CB)])

    def x_platform(method, url, headers, body):
        if url.endswith("/2/oauth2/token"):
            return 200, {}, {"access_token": "AT1", "refresh_token": "RT1", "expires_in": 7200}
        if url.endswith("/2/users/me"):
            return 200, {}, {"data": {"id": "999", "username": "shop"}}
        if "/dm_conversations/with/" in url:
            return 201, {}, {"data": {"dm_event_id": "dm-1"}}
        if url.endswith("/2/tweets"):
            return 201, {}, {"data": {"id": "tw-1"}}
        if url.endswith("/2/webhooks"):
            return 200, {}, {"data": {"id": "wh1"}}
        if "/subscriptions/all" in url:
            return 200, {}, {"data": {"subscribed": True}}
        return 404, {}, {"detail": "unexpected " + url}

    HTTP["fn"] = x_platform
    current_p["p"] = dict(owner, client_id=8)
    r = client.post(URL + "/oauth/finish", json={"state": state, "code": "abc"})
    check("another workspace cannot use the state (and burns it)", r.status_code == 400)
    current_p["p"] = owner
    r = client.post(URL + "/oauth/finish", json={"state": state, "code": "abc"})
    check("state is one-time", r.status_code == 400)
    state = parse_qs(urlparse(client.post(URL + "/x/oauth/start", json={"redirect_uri": CB}).get_json()["url"])
                     .query)["state"][0]
    HTTP["calls"].clear()
    r = client.post(URL + "/oauth/finish", json={"state": state, "code": "abc"})
    token_call = HTTP["calls"][0]
    check("finish: code exchanged with PKCE verifier + Basic auth", r.status_code == 200
          and r.get_json() == {"ok": True, "channel": "x"} and "code_verifier=" in token_call[3]
          and token_call[2]["Authorization"].startswith("Basic "), token_call)
    row = sql("SELECT enabled, account_id, account_name, access_token, flags FROM portal_social_accounts"
              " WHERE client_id = 7 AND channel = 'x'")[0]
    check("connected: on, account stored, DMs + comments on, publishing off until switched on",
          row[0] is True and row[1] == "999" and row[2] == "@shop"
          and row[4] == {"dm": True, "comments": True, "publish": False}, row)
    sql("UPDATE portal_social_oauth SET expires_at = NOW() - INTERVAL '1 minute'", fetch=False)
    expired = parse_qs(urlparse(client.post(URL + "/x/oauth/start", json={"redirect_uri": CB}).get_json()["url"])
                       .query)["state"][0]
    sql("UPDATE portal_social_oauth SET expires_at = NOW() - INTERVAL '1 minute' WHERE state = %s", (expired,),
        fetch=False)
    check("expired state -> 400", client.post(URL + "/oauth/finish", json={"state": expired, "code": "c"})
          .status_code == 400)

    print("== X webhook ==")
    r = client.post(URL + "/x/webhook")
    check("webhook registered (bearer) + account subscribed (user token)", r.status_code == 200
          and r.get_json()["webhook_url"] == BASE + "/api/v1/public/social/x/webhook/" + stored[1]
          and any(c[1].endswith("/2/webhooks") and c[2]["Authorization"] == "Bearer bearer-12345" for c in HTTP["calls"])
          and any("/webhooks/wh1/subscriptions/all" in c[1] and c[2]["Authorization"] == "Bearer AT1"
                  for c in HTTP["calls"]), r.get_json())
    hook = "/api/v1/public/social/x/webhook/" + stored[1]
    r = client.get(hook + "?crc_token=abc")
    want = "sha256=" + base64.b64encode(hmac.new(b"consumer-12345", b"abc", hashlib.sha256).digest()).decode()
    check("CRC answered with the consumer secret", r.status_code == 200 and r.get_json()["response_token"] == want)
    check("CRC unknown hook -> 404", client.get("/api/v1/public/social/x/webhook/nope?crc_token=a").status_code == 404)

    def x_post(payload, secret=b"csecret-12345", header="X-Twitter-Webhooks-Signature-OAuth2"):
        raw_body = json.dumps(payload).encode()
        sig = "sha256=" + base64.b64encode(hmac.new(secret, raw_body, hashlib.sha256).digest()).decode()
        return client.post(hook, data=raw_body, content_type="application/json", headers={header: sig})

    brain_calls = []

    def brain(client_id, conversation_id, contact_id, contact_name, body, conn):
        brain_calls.append((client_id, contact_id))
        with conn.cursor() as cur:
            cur.execute("INSERT INTO portal_connector_commands (client_id, channel, action, payload, status)"
                        " VALUES (%s, %s, 'send_message', %s::jsonb, 'pending')",
                        (client_id, portal_channels.channel_for_contact(contact_id),
                         json.dumps({"external_user_id": contact_id, "body": "Ji, 1500 rupay.", "source": "ai_brain"})))
        return True

    portal_brain.maybe_answer = brain
    check("unsigned / wrong secret -> 403", client.post(hook, json=X_PAYLOAD).status_code == 403
          and x_post(X_PAYLOAD, b"wrong").status_code == 403)
    HTTP["calls"].clear()
    r = x_post(X_PAYLOAD)
    conv = sql("SELECT contact_id, channel FROM portal_conversations WHERE client_id = 7 ORDER BY contact_id")
    check("signed DM + mention: two conversations on the x channel", r.status_code == 200
          and r.get_json()["ingested"] == 2 and conv == [("x:55", "x"), ("xc:66", "x")], (r.get_json(), conv))
    check("comment stored as the reply target", sql("SELECT contact_id, comment_id FROM portal_social_comments")
          == [("xc:66", "t1")])
    sent_dm = [c for c in HTTP["calls"] if "/dm_conversations/with/55/messages" in c[1]]
    check("brain's DM answer sent by the Control Plane in the same request",
          len(sent_dm) == 1 and sent_dm[0][3] == {"text": "Ji, 1500 rupay."}, HTTP["calls"])
    cmds = dict(sql("SELECT payload->>'external_user_id', status FROM portal_connector_commands"
                    " WHERE client_id = 7 AND channel = 'x'"))
    check("the AI's public comment answer is refused (auto-reply off); the DM is done",
          cmds == {"x:55": "done", "xc:66": "dead"}, cmds)
    msgs = sql("SELECT m.direction, m.body FROM portal_messages m JOIN portal_conversations c"
               " ON c.id = m.conversation_id WHERE c.contact_id = 'x:55' ORDER BY m.id")
    check("conversation shows the DM and the sent reply", msgs == [("in", "Price?"), ("out", "Ji, 1500 rupay.")], msgs)
    r = x_post(X_PAYLOAD, b"consumer-12345", "X-Twitter-Webhooks-Signature")
    check("legacy header with the consumer secret accepted; retries deduplicated",
          r.status_code == 200 and sql("SELECT COUNT(*) FROM portal_messages")[0][0] == 3 and len(brain_calls) == 2)
    portal_brain.maybe_answer = lambda *a, **k: None

    print("== sending ==")

    def queue(client_id, channel, payload, action="send_message"):
        return sql("INSERT INTO portal_connector_commands (client_id, channel, action, payload, status)"
                   " VALUES (%s, %s, %s, %s::jsonb, 'pending') RETURNING id",
                   (client_id, channel, action, json.dumps(payload)))[0][0]

    def status_of(command_id):
        return sql("SELECT status, error_code FROM portal_connector_commands WHERE id = %s", (command_id,))[0]

    manual = queue(7, "x", {"external_user_id": "xc:66", "body": "Shukriya! " + "z" * 400, "source": "manual"})
    media = queue(7, "x", {"external_user_id": "x:55", "asset_id": 1}, action="send_media")
    HTTP["calls"].clear()
    res = S.run(7)
    reply = [c for c in HTTP["calls"] if c[1].endswith("/2/tweets")]
    check("manual comment reply sent to the mention, cut to 280", res["sent"] == 1 and res["refused"] == 1
          and reply[0][3]["reply"] == {"in_reply_to_tweet_id": "t1"} and len(reply[0][3]["text"]) == 280, res)
    check("media refused (final)", status_of(media) == ("dead", "refused") and status_of(manual)[0] == "done")
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (7, 'x:77')", fetch=False)
    opted = queue(7, "x", {"external_user_id": "x:77", "body": "offer", "source": "broadcast"})
    S.run(7)
    check("opted-out customer never messaged", status_of(opted) == ("dead", "refused"))

    calls = {"n": 0}

    def expired_then_ok(method, url, headers, body):
        if url.endswith("/2/oauth2/token"):
            return 200, {}, {"access_token": "AT2", "refresh_token": "RT2", "expires_in": 7200}
        if "/dm_conversations/" in url:
            calls["n"] += 1
            if headers.get("Authorization") == "Bearer AT1":
                return 401, {}, {"detail": "expired"}
            return 201, {}, {"data": {"dm_event_id": "dm-2"}}
        return x_platform(method, url, headers, body)

    HTTP["fn"] = expired_then_ok
    refresh = queue(7, "x", {"external_user_id": "x:55", "body": "Again", "source": "manual"})
    res = S.run(7)
    check("401: token refreshed once, reply sent with the new token", res["sent"] == 1 and calls["n"] == 2
          and status_of(refresh)[0] == "done", res)
    sealed = sql("SELECT access_token FROM portal_social_accounts WHERE client_id = 7 AND channel = 'x'")[0][0]
    check("refreshed token stored", S.portal_vault.unseal(sealed) == "AT2")

    def always_401(method, url, headers, body):
        if url.endswith("/2/oauth2/token"):
            return 400, {}, {"error": "invalid_grant"}
        return 401, {}, {"detail": "revoked"}

    HTTP["fn"] = always_401
    waiting = queue(7, "x", {"external_user_id": "x:55", "body": "Later", "source": "manual"})
    res = S.run(7)
    err = sql("SELECT last_error FROM portal_social_accounts WHERE client_id = 7 AND channel = 'x'")[0][0]
    check("revoked: reply stays queued (no attempt spent), the card says reconnect",
          status_of(waiting)[0] == "pending" and "connect the account again" in err
          and sql("SELECT attempts FROM portal_connector_commands WHERE id = %s", (waiting,))[0][0] in (0, None), err)
    for code, want in ((429, "pending"), (400, "dead")):
        sql("UPDATE portal_connector_commands SET status = 'done' WHERE id = %s", (waiting,), fetch=False)
        respond(code, {"detail": "nope"})
        one = queue(7, "x", {"external_user_id": "x:55", "body": "c%d" % code, "source": "manual"})
        S.run(7)
        check("HTTP %d -> %s" % (code, want), status_of(one)[0] == want, status_of(one))
        sql("UPDATE portal_connector_commands SET status = 'done' WHERE id = %s", (one,), fetch=False)
    sql("UPDATE portal_social_accounts SET last_error = '' WHERE channel = 'x'", fetch=False)

    print("== posts + approvals ==")
    HTTP["fn"] = x_platform
    r = client.post(URL + "/posts", json={"channel": "x", "text": "Sale!"})
    check("publishing off -> 400", r.status_code == 400 and "Turn on publishing" in r.get_json()["error"]["message"])
    client.put(URL + "/x", json={"flags": {"publish": True}})
    check("media on X refused", client.post(URL + "/posts", json={"channel": "x", "text": "a",
                                                                  "media_url": "https://v/x.mp4"}).status_code == 400)
    HTTP["calls"].clear()
    r = client.post(URL + "/posts", json={"channel": "x", "text": "Sale today!"})
    post_row = sql("SELECT status, provider_post_id FROM portal_social_posts ORDER BY id DESC LIMIT 1")[0]
    listed = client.get(URL).get_json()["posts"]
    check("contract: post keys == SocialPost", listed and set(listed[0]) == ts_keys("SocialPost"),
          set(listed[0]) ^ ts_keys("SocialPost") if listed else listed)
    check("owner: published right away", r.status_code == 200 and r.get_json()["status"] == "queued"
          and post_row == ("published", "tw-1") and any(c[3] == {"text": "Sale today!"} for c in HTTP["calls"]),
          (r.get_json(), post_row))
    current_p["p"] = dict(owner, role="agent", user_id=4)
    HTTP["calls"].clear()
    r = client.post(URL + "/posts", json={"channel": "x", "text": "Agent post"})
    current_p["p"] = owner
    appr = sql("SELECT id, kind, risk, contact_id, status FROM portal_approvals ORDER BY id DESC LIMIT 1")[0]
    check("agent: waits for a HIGH-risk social_post approval, nothing published",
          r.get_json()["status"] == "pending_approval" and appr[1:] == ("social_post", "high",
                                                                         "post:x:" + str(r.get_json()["id"]), "pending")
          and HTTP["calls"] == [], appr)
    c = portal_db._conn()
    with c.cursor() as cur:
        cur.execute("SELECT * FROM portal_approvals WHERE id = %s", (appr[0],))
        approval = portal_db.rows(cur)[0]
        outcome = S.resolve_post_approval(cur, 7, approval, True)
    c.commit()
    c.close()
    check("approve: queued for publishing", outcome["outcome"] == "executed" and sql(
        "SELECT status FROM portal_social_posts WHERE id = %s", (r.get_json()["id"],))[0][0] == "queued")
    S.run(7)
    check("then published by the outbox", sql("SELECT status FROM portal_social_posts WHERE id = %s",
                                              (r.get_json()["id"],))[0][0] == "published")
    ai = None
    c = portal_db._conn()
    with c.cursor() as cur:
        ai = S.request_post(cur, 7, "x", "AI draft post")
        cur.execute("SELECT * FROM portal_approvals WHERE contact_id = %s", ("post:x:" + str(ai["id"]),))
        rejected = S.resolve_post_approval(cur, 7, portal_db.rows(cur)[0], False)
        again = S.resolve_post_approval(cur, 7, {"context_json": {"post_id": ai["id"]}}, True)
    c.commit()
    c.close()
    check("AI post: always an approval; reject -> rejected, never published, no double decision",
          ai["status"] == "pending_approval" and rejected["outcome"] == "recorded" and again["outcome"] == "recorded"
          and sql("SELECT status FROM portal_social_posts WHERE id = %s", (ai["id"],))[0][0] == "rejected")

    print("== YouTube + TikTok ==")
    sql("INSERT INTO portal_social_accounts (client_id, channel, mode, enabled, access_token, account_id, hook_key,"
        " flags, cursor) VALUES (7, 'youtube', 'api', TRUE, 'YT', '999', 'hk-yt', '{\"comments\": true}', '{}')",
        fetch=False)
    HTTP["fn"] = yt_threads
    S.run(7, ("youtube",))
    check("YouTube first run: cursor set, nothing imported",
          sql("SELECT COUNT(*) FROM portal_conversations WHERE channel = 'youtube'")[0][0] == 0
          and sql("SELECT cursor ? 'since' FROM portal_social_accounts WHERE channel = 'youtube'")[0][0] is True)
    sql("UPDATE portal_social_accounts SET cursor = %s WHERE channel = 'youtube'",
        (json.dumps({"since": NOW.timestamp()}),), fetch=False)

    def yt_all(method, url, headers, body):
        if "/comments?part=snippet" in url:
            return 200, {}, {"id": "reply-1"}
        return yt_threads()

    HTTP["fn"] = yt_all
    res = S.run(7, ("youtube",))
    check("YouTube: new comment -> ytc: conversation", res["received"] == 1 and sql(
        "SELECT contact_id FROM portal_conversations WHERE channel = 'youtube'") == [("ytc:UCa",)], res)
    yt_cmd = queue(7, "youtube", {"external_user_id": "ytc:UCa", "body": "Kal tak.", "source": "approval"})
    HTTP["calls"].clear()
    S.run(7, ("youtube",))
    check("YouTube reply posted under the comment", status_of(yt_cmd)[0] == "done"
          and HTTP["calls"][-1][3] == {"snippet": {"parentId": "c3", "textOriginal": "Kal tak."}}, HTTP["calls"][-1:])
    sql("INSERT INTO portal_away_replies (client_id, contact_id, body) VALUES (7, 'ytc:UCa', 'Band hain')", fetch=False)
    S.run(7, ("youtube",))
    check("away replies never posted as public comments", sql(
        "SELECT status FROM portal_away_replies WHERE contact_id = 'ytc:UCa'") == [("failed",)])

    sql("INSERT INTO portal_social_accounts (client_id, channel, mode, enabled, app_secret, access_token, account_id,"
        " hook_key, flags) VALUES (7, 'tiktok', 'api', TRUE, 'ttsec', 'TT', '999', 'hk-tt', '{\"dm\": true}')",
        fetch=False)
    raw_tt = json.dumps(TT).encode()
    stamp = str(int(time.time()))
    sig = "t=" + stamp + ",s=" + hmac.new(b"ttsec", stamp.encode() + b"." + raw_tt, hashlib.sha256).hexdigest()
    respond(200, {"code": 0, "data": {"message_id": "m9"}})
    r = client.post("/api/v1/public/social/tiktok/webhook/hk-tt", data=raw_tt, content_type="application/json",
                    headers={"Tiktok-Signature": sig})
    check("TikTok signed DM -> tt: conversation", r.status_code == 200 and sql(
        "SELECT contact_id FROM portal_conversations WHERE channel = 'tiktok'") == [("tt:cv1",)])
    check("TikTok bad signature -> 403", client.post("/api/v1/public/social/tiktok/webhook/hk-tt", data=raw_tt,
                                                     headers={"Tiktok-Signature": "t=1,s=00"}).status_code == 403)
    tt_cmd = queue(7, "tiktok", {"external_user_id": "tt:cv1", "body": "Ji", "source": "manual"})
    HTTP["calls"].clear()
    S.run(7, ("tiktok",))
    check("TikTok reply sent to the conversation", status_of(tt_cmd)[0] == "done" and HTTP["calls"][-1][3] == {
        "business_id": "999", "recipient_type": "CONVERSATION", "recipient": "cv1", "message_type": "TEXT",
        "text": {"body": "Ji"}}, HTTP["calls"][-1:])

    print("== login mode ==")
    capp = Flask("connector")
    capp.register_blueprint(connector_api.bp)
    capp.register_blueprint(S.connector_bp)
    cclient = capp.test_client()
    headers = {"X-Omniflow-Key": os.environ["OMNIFLOW_SERVICE_KEY"]}
    import portal_sms
    import portal_email_channel
    saved_kicks = (portal_sms.kick, portal_email_channel.kick)
    portal_sms.kick = portal_email_channel.kick = lambda cid: False
    api_cmd = queue(7, "x", {"external_user_id": "x:55", "body": "api", "source": "manual"})
    r = cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&channel=x", headers=headers)
    check("API mode: the login bridge gets nothing and the reply stays queued for the Control Plane",
          r.status_code == 200 and r.get_json()["commands"] == [] and status_of(api_cmd)[0] == "pending",
          status_of(api_cmd))
    wa = queue(7, "whatsapp", {"external_user_id": "923001112222", "body": "wa"})
    ids = [c["id"] for c in cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&limit=50",
                                        headers=headers).get_json()["commands"]]
    check("unfiltered (WhatsApp) poll never sees social work", wa in ids and api_cmd not in ids, ids)
    sql("UPDATE portal_connector_commands SET status = 'done' WHERE id IN (%s, %s)", (api_cmd, wa), fetch=False)
    client.put(URL + "/x", json={"mode": "login"})
    client.put(URL + "/x", json={"enabled": True, "flags": {"dm": True, "comments": True}})
    row = sql("SELECT mode, enabled, access_token FROM portal_social_accounts WHERE client_id = 7 AND channel = 'x'")[0]
    check("login mode: tokens cleared, on", row == ("login", True, ""), row)
    allowed = queue(7, "x", {"external_user_id": "xc:66", "body": "Thanks", "source": "manual"})
    ai_public = queue(7, "x", {"external_user_id": "xc:66", "body": "AI", "source": "ai_brain"})
    dm = queue(7, "x", {"external_user_id": "x:55", "body": "y" * 12000, "source": "ai_brain"})
    r = cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&channel=x", headers=headers)
    got = {c["id"]: c["payload"] for c in r.get_json()["commands"]}
    check("bridge gets the allowed commands with the tweet to reply to and fitted text",
          set(got) == {allowed, dm} and got[allowed]["reply_to"] == "t1" and len(got[dm]["body"]) == 10000, got.keys())
    check("the AI's public reply refused for the bridge too", status_of(ai_public) == ("dead", "refused"))
    check("bridge poll marks the bridge seen", sql(
        "SELECT bridge_seen_at IS NOT NULL FROM portal_social_accounts WHERE channel = 'x'")[0][0] is True)
    sql("INSERT INTO portal_away_replies (client_id, contact_id, body) VALUES (7, 'x:55', 'Band'), (7, 'xc:66', 'Band'),"
        " (7, '923001112222', 'Band'), (7, 'tgu:5', 'Band')", fetch=False)
    users = lambda q: [a["external_user_id"] for a in cclient.get(  # noqa: E731
        "/api/v1/connector/away-replies?client_id=7&limit=20" + q, headers=headers).get_json()["away_replies"]]
    check("away: WhatsApp poll skips social; the X bridge gets X DMs only; Telegram personal off -> none",
          users("") == ["923001112222"] and users("&social=x") == ["x:55"] and users("&social=telegram_user") == [])
    check("away: unknown social -> 400", cclient.get("/api/v1/connector/away-replies?client_id=7&social=fax",
                                                     headers=headers).status_code == 400)
    r = cclient.post("/api/v1/connector/social/messages", headers=headers, json={"client_id": 7, "channel": "x", "messages": [
        {"from": "x:88", "body": "Login DM", "id": "x-dm:900", "name": "Zara"},
        {"from": "xc:89", "body": "Login mention", "id": "x-c:901", "comment_id": "901", "post_id": "901"},
        {"from": "tt:1", "body": "wrong channel", "id": "z"}]})
    check("bridge ingest: DM + mention imported, foreign prefix ignored", r.status_code == 200
          and r.get_json()["ingested"] == 2 and sql(
              "SELECT comment_id FROM portal_social_comments WHERE contact_id = 'xc:89'") == [("901",)], r.get_json())
    r = cclient.post("/api/v1/connector/social/status", headers=headers,
                     json={"client_id": 7, "channel": "x", "state": "connected", "account_name": "@shop"})
    check("heartbeat: active + the features on in login mode",
          r.get_json() == {"ok": True, "active": True, "features": ["dm", "comments", "publish"]}, r.get_json())
    check("test in login mode: bridge live", client.post(URL + "/x/test").status_code == 200)
    check("bad heartbeat -> 400", cclient.post("/api/v1/connector/social/status", headers=headers,
                                               json={"client_id": 7, "channel": "tiktok", "state": "connected"})
          .status_code == 400)

    print("== login bridge loop against the Control Plane ==")
    import asyncio

    class StopLoop(BaseException):
        pass

    loop_log = {"sent": [], "fetch": [[{"from": "x:91", "body": "loop dm", "id": "x-dm:950", "name": "Hina"}]],
                "fail_ingest": 1, "sleeps": 0}

    class FakeX:
        async def start(self):
            return "@shop"

        async def fetch(self):
            return loop_log["fetch"].pop(0) if loop_log["fetch"] else []

        async def send(self, command):
            loop_log["sent"].append(command["payload"])
            return "prov-" + str(len(loop_log["sent"]))

    def bridge_http(path, payload=None):
        if payload is None:
            r = cclient.get(path + ("&" if "?" in path else "?") + "client_id=7", headers=headers)
        else:
            if path.endswith("/social/messages") and loop_log["fail_ingest"]:
                loop_log["fail_ingest"] -= 1
                raise OSError("network down")
            r = cclient.post(path, json=dict(payload, client_id=7), headers=headers)
        if r.status_code >= 400:
            raise RuntimeError("HTTP %d %s %s" % (r.status_code, path, r.get_data(as_text=True)[:200]))
        return r.get_json()

    async def fake_sleep(seconds):
        loop_log["sleeps"] += 1
        if loop_log["sleeps"] >= 2:
            raise StopLoop()

    login_post = client.post(URL + "/posts", json={"channel": "x", "text": "Login post"}).get_json()
    check("login mode: owner post queued for the bridge", login_post.get("status") == "queued", login_post)
    real_sleep, B._http_json, B.ACCOUNTS["x"] = B.asyncio.sleep, bridge_http, FakeX
    pending_before = sorted(i for (i,) in sql("SELECT id FROM portal_connector_commands WHERE client_id = 7"
                                              " AND channel = 'x' AND status = 'pending'"))
    B.asyncio.sleep = fake_sleep
    try:
        asyncio.run(B.run_channel("x"))
    except StopLoop:
        pass
    finally:
        B.asyncio.sleep = real_sleep
    check("loop: a failed ingest is retried from the backlog, imported once", sql(
        "SELECT COUNT(*) FROM portal_messages m JOIN portal_conversations c ON c.id = m.conversation_id"
        " WHERE c.contact_id = 'x:91'")[0][0] == 1 and loop_log["fail_ingest"] == 0)
    check("loop: handed commands sent (comment reply with its tweet) and acked done with the provider id",
          any(p.get("reply_to") == "t1" for p in loop_log["sent"]) and pending_before and sql(
              "SELECT COUNT(*) FROM portal_connector_commands WHERE id = ANY(%s) AND status = 'done'",
              (pending_before,))[0][0] == len(pending_before), (pending_before, loop_log["sent"]))
    shown = [p for p in client.get(URL).get_json()["posts"] if p["id"] == login_post["id"]]
    check("login publish: bridge's provider id mirrored to the post", shown and shown[0]["status"] == "published"
          and shown[0]["provider_post_id"].startswith("prov-"), shown)
    extra = queue(7, "x", {"external_user_id": "x:55", "body": "ack me", "source": "manual"})
    r = cclient.post("/api/v1/connector/whatsapp/commands/ack", headers=headers,
                     json={"client_id": 7, "command_id": extra, "ok": True, "note": "m1"})
    check("command ack answers 200 once saved (was 404 after the bookkeeping update)",
          r.status_code == 200 and status_of(extra)[0] == "done", (r.status_code, r.get_json()))
    r = cclient.post("/api/v1/connector/whatsapp/commands/ack", headers=headers,
                     json={"client_id": 7, "command_id": 99999, "ok": True})
    check("ack of an unknown command still 404", r.status_code == 404)
    check("loop: heartbeat stored the account name", sql(
        "SELECT bridge_state, account_name FROM portal_social_accounts WHERE client_id = 7 AND channel = 'x'")
          == [("connected", "@shop")])
    B.ACCOUNTS["x"] = B.XAccount

    print("== Telegram personal ==")
    r = client.put(URL + "/telegram_user", json={"enabled": True, "flags": {"dm": True}})
    check("Telegram personal switched on, stored in login mode", r.status_code == 200 and sql(
        "SELECT mode FROM portal_social_accounts WHERE client_id = 7 AND channel = 'telegram_user'") == [("login",)])
    tgu = queue(7, portal_channels.channel_for_contact("tgu:5"), {"external_user_id": "tgu:5", "body": "Salam",
                                                                   "source": "manual"})
    bot = [c["id"] for c in cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&channel=telegram",
                                        headers=headers).get_json()["commands"]]
    mine = [c["id"] for c in cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&channel=telegram_user",
                                         headers=headers).get_json()["commands"]]
    check("tgu: work goes to the personal bridge, never the bot bridge", tgu in mine and tgu not in bot, (bot, mine))
    check("Telegram personal away replies once on", users("&social=telegram_user") == ["tgu:5"])
    portal_sms.kick, portal_email_channel.kick = saved_kicks

    print("== isolation + disconnect ==")
    queue(8, "x", {"external_user_id": "x:55", "body": "w8", "source": "manual"})
    res = S.run(8)
    check("workspace without accounts sends nothing", res["sent"] == 0 and sql(
        "SELECT status FROM portal_connector_commands WHERE client_id = 8") == [("pending",)])
    current_p["p"] = dict(owner, client_id=8)
    check("another workspace sees its own (empty) channels", all(
        not c["enabled"] for c in client.get(URL).get_json()["channels"]))
    current_p["p"] = owner
    r = client.post(URL + "/youtube/disconnect")
    check("disconnect clears tokens and switches off", r.status_code == 200 and sql(
        "SELECT enabled, access_token FROM portal_social_accounts WHERE channel = 'youtube'") == [(False, "")])
    S.kick = real_kick


run_db()
sys.exit(1 if summary("social_channels") else 0)
