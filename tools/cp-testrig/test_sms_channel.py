"""§244 SMS channel (portal_sms + portal_cp_outbox + Twilio number wiring).

Units: env clamps, GSM / UCS-2 segment counting (extension characters,
emoji), shortening at a word boundary, contact parsing and masking, Twilio
error classes, early refusals, MMS notes, settings cleaning, the tick
throttle, dispatch_now, the Twilio number SMS state and the SMS-only
connect call, source pins (tenant scoping, no message bodies stored, tick
and inbox kicks, both reply routes dispatch after commit, blueprints).
HTTP guards (401 / 503 / 403 API key / 403 non-editor / 400 validation /
503 without internals) and the public webhooks (signature enforced, no keys
-> nothing imported, short codes / empty / unknown statuses ignored).
Then the real thing on pgserver with a fake Twilio: enabling needs keys and
a number, signed inbound SMS through the shared ingest (conversation,
identity merged with WhatsApp, brain reply sent in the same request),
Twilio retries deduped, unassigned / switched-off numbers ignored, queued
replies + away replies sent from the workspace number with a status
callback, long replies shortened, media refused, daily limit, laptop
bridges never see SMS work, Twilio 5xx retry / 400 refuse / 401 keeps the
attempt, keys or number missing keep replies queued, STOP opt-out, switched
off refuses, delivery callbacks never go backwards, the test message
(gap, limit, Twilio errors, masked audit), the advisory lock, a foreign
workspace, and the admin connect route with what=sms.
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
os.environ["OF_PROACTIVE"] = "0"
for name in ("OF_SMS_CHANNEL", "OF_SMS_DAILY_MAX", "OF_SMS_DAILY_DEFAULT", "OF_SMS_MAX_SEGMENTS",
             "OF_SMS_MAX_SEND", "OF_SMS_POLL_SECONDS", "OF_SMS_TEST_GAP_SECONDS", "OF_SMS_TEST_TEXT",
             "OF_SMS_LOG_TABLE", "OF_NOTIFY_ROLES", "OMNIFLOW_SITE_URL"):
    os.environ.pop(name, None)
BASE = "https://cp.example.com"
os.environ["OMNIFLOW_TWILIO_WEBHOOK_BASE"] = BASE
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_sms as S  # noqa: E402
import portal_voice  # noqa: E402
import portal_channels  # noqa: E402
import connector_api  # noqa: E402
from portal_auth import PortalAuthUnavailable  # noqa: E402

HERE = os.getcwd()


def src(name):
    return open(os.path.join(HERE, name), encoding="utf8").read()


KEYS = {"account_sid": "AC123", "auth_token": "tok", "from_number": ""}
KEY_STATE = {"keys": dict(KEYS)}
portal_voice._voice_keys = lambda: dict(KEY_STATE["keys"])
portal_voice._signature_mode = lambda: "enforce"
portal_voice._panel_webhook_base = lambda: ""  # the env base is used; no panel read
TW = {"calls": [], "script": [], "n": 0}


def fake_twilio(keys, method, path, params=None):
    TW["calls"].append((method, path, dict(params or {})))
    if TW["script"]:
        step = TW["script"].pop(0)
        if isinstance(step, Exception):
            raise step
        return step
    TW["n"] += 1
    return {"sid": "SM%032d" % TW["n"], "status": "queued"}


portal_voice._twilio_api = fake_twilio


def sign(token, url, params):
    payload = url + "".join(k + v for k, v in sorted(params.items()))
    return base64.b64encode(hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest()).decode()


print("== config ==")
check("defaults: daily 100 of max 500, 4 parts, 10 per run, 30 s tick, 60 s test gap",
      (S.DAILY_DEFAULT, S.DAILY_MAX, S.MAX_SEGMENTS, S.MAX_SEND_PER_RUN, S.POLL_SECONDS,
       S.TEST_GAP_SECONDS, S.LOG_TABLE, S.ENABLED) == (100, 500, 4, 10, 30, 60, "portal_sms_log", True))
os.environ["OF_T_X"] = "abc"
check("env ints: junk -> default, clamped both ways",
      S._env_int("OF_T_X", 7, 1, 9) == 7 and S._env_int("OF_T_NONE", 70, 1, 9) == 9
      and S._env_int("OF_T_NONE", -5, 1, 9) == 1)
os.environ.pop("OF_T_X")
check("paths and prefix", S.INCOMING_PATH == "/api/v1/public/sms/incoming"
      and S.STATUS_PATH == "/api/v1/public/sms/status" and S.PREFIX == "sms:" and S.DISPATCH_LIMIT == 3)

print("== segments ==")
check("GSM: empty 0, 160 -> 1, 161 -> 2, 306 -> 2, 307 -> 3",
      [S.segments("a" * n) for n in (0, 160, 161, 306, 307)] == [0, 1, 2, 2, 3])
check("GSM extension characters count double (80 euro signs fit one part, 81 do not)",
      S.is_gsm("€[]{}") and S.segments("€" * 80) == 1 and S.segments("€" * 81) == 2)
check("Urdu is UCS-2: 70 -> 1, 71 -> 2", not S.is_gsm("آپ") and S.segments("ک" * 70) == 1
      and S.segments("ک" * 71) == 2)
check("emoji take two UCS-2 units", S.segments("\U0001F600" * 35) == 1 and S.segments("\U0001F600" * 36) == 2)
check("one non-GSM character makes the whole text UCS-2", S.segments("a" * 100 + "ک") == 2)
text, parts, short = S.fit("Ji   aap ka order\tkal deliver hoga.")
check("short reply: whitespace tidied, unchanged otherwise", (text, parts, short)
      == ("Ji aap ka order kal deliver hoga.", 1, False), (text, parts, short))
words = " ".join("word%d" % i for i in range(400))
text, parts, short = S.fit(words)
check("long GSM reply cut to 4 parts at a word boundary with an ellipsis",
      short and parts <= 4 and S.segments(text) <= 4 and text.endswith("...")
      and words.startswith(text[:-3]) and text[:-3].split()[-1] in words.split(), (parts, text[-20:]))
text, parts, short = S.fit("آپ کا آرڈر " * 60)
check("long Urdu reply stays within 4 UCS-2 parts", short and parts <= 4 and text.endswith("..."), parts)
text, parts, short = S.fit(words, 1)
check("one-part limit honoured", short and parts == 1 and len(text) <= 160, len(text))

print("== contacts + Twilio errors ==")
check("phone_of: sms:+E164 only", [S.phone_of(c) for c in (
    "sms:+923001234567", "SMS:+923001234567", "sms:03001234567", "923001234567", "sms:+0123", "", None)]
      == ["+923001234567", "+923001234567", "", "", "", "", ""])
check("mask keeps the last 4 digits only", S._mask("sms:+923001234567") == "...4567" and S._mask("x") == "")
err = portal_voice.TwilioApiError
check("Twilio errors: 401/403 auth, 400/404 final, else retry",
      [S._classify(err(c, "x")) for c in (401, 403, 400, 404, 429, 500, 502)]
      == ["auth", "auth", "final", "final", "retry", "retry", "retry"])


def item(action="send_message", contact="sms:+923001234567", body="hi"):
    return {"kind": "command", "id": 1, "action": action,
            "payload": {"external_user_id": contact, "body": body}}


check("early refusals: media / template, no mobile number, empty body",
      S.refusal(None, 7, item("send_media")).startswith("SMS replies support text")
      and S.refusal(None, 7, item("send_template")).startswith("SMS replies support text")
      and "no valid mobile" in S.refusal(None, 7, item(contact="em:a@b.pk"))
      and "no valid mobile" in S.refusal(None, 7, item(contact="923001234567"))
      and "empty" in S.refusal(None, 7, item(body="  ")))
check("MMS: note with the count, bad NumMedia ignored, body capped",
      S.inbound_body({"Body": " hi ", "NumMedia": "2"}).startswith("hi\n[The customer sent 2 pictures / files")
      and S.inbound_body({"Body": "", "NumMedia": "1"}).startswith("[The customer sent 1 picture / file by")
      and S.inbound_body({"Body": "x", "NumMedia": "lots"}) == "x"
      and len(S.inbound_body({"Body": "y" * 5000})) == S.MAX_BODY_IN)
check("settings cleaning: defaults, bool limit ignored, limit clamped, junk dropped",
      S._clean(None) == S.default_settings()
      and S._clean({"enabled": "yes", "daily_limit": True})["daily_limit"] == 100
      and S._clean({"enabled": "yes"})["enabled"] is False
      and S._clean({"daily_limit": 10**6})["daily_limit"] == 500
      and S._clean({"daily_limit": 0})["daily_limit"] == 1
      and S._clean({"last_error": "e" * 900})["last_error"] == "e" * 300)

print("== Twilio number: SMS state + connect ==")
num = {"sid": "PN" + "a" * 32, "phone_number": "+14155550100", "friendly_name": "Main",
       "capabilities": {"voice": True, "sms": True}}
SMS_URL = BASE + S.INCOMING_PATH
for extra, want in (({"sms_url": SMS_URL}, "connected"), ({"sms_url": SMS_URL + "/"}, "connected"),
                    ({"sms_url": "https://demo.twilio.com/welcome/sms/reply"}, "elsewhere"),
                    ({}, "not_set"), ({"sms_url": SMS_URL, "sms_application_sid": "AP1"}, "app")):
    state = portal_voice.twilio_number_state(dict(num, **extra), BASE)
    check("sms state " + want, state["sms_state"] == want and state["sms_capable"] is True, state)
state = portal_voice.twilio_number_state(dict(num, sms_url="https://hooks.other.io/x?k=1"), BASE)
check("sms host shown without path or query", state["sms_host"] == "hooks.other.io", state["sms_host"])
check("no sms capability / no capabilities -> not capable", portal_voice.twilio_number_state(
    dict(num, capabilities={"voice": True}), BASE)["sms_capable"] is False
      and portal_voice.twilio_number_state({"sid": "x"}, BASE)["sms_capable"] is False)
check("no base -> nothing counts as connected",
      portal_voice.twilio_number_state(dict(num, sms_url=SMS_URL), "")["sms_state"] == "elsewhere")
TW["calls"].clear()
portal_voice.connect_twilio_sms(KEYS, "PN" + "a" * 32, BASE)
check("SMS connect sends only the two SMS fields (voice untouched)", TW["calls"] == [
    ("POST", "/IncomingPhoneNumbers/PN" + "a" * 32 + ".json", {"SmsUrl": SMS_URL, "SmsMethod": "POST"})],
      TW["calls"])
TW["calls"].clear()

print("== routing + wiring ==")
check("channel_for_contact: sms: -> sms",
      [portal_channels.channel_for_contact(c) for c in ("sms:+923001234567", "SMS:+1", "em:a@b.pk", "9230")]
      == ["sms", "sms", "email", "whatsapp"])
check("sms is an ingest channel and Control-Plane dispatched",
      "sms" in connector_api.ALLOWED_CHANNELS and "sms" in connector_api.CP_DISPATCHED_CHANNELS)
CONN = src("connector_api.py")
check("laptop away-reply poll excludes sms: contacts", "\" AND contact_id NOT LIKE 'sms:%%'\"" in CONN)
check("connector tick kicks the SMS channel in its own guard",
      "                    import portal_sms\n" in CONN and 'portal_sms.kick(tenant["client_id"])' in CONN)
CONV = src("portal_conversations.py")
check("inbox list kicks SMS", 'portal_sms.kick(principal.get("client_id"))' in CONV)
for label, failure in (("conversation reply", 'portal_unavailable(error, "conversation reply")[0]), 503'),
                       ("manual message", 'portal_unavailable(error, "manual message")[0]), 503')):
    at = CONV.index(failure)
    nxt = CONV.index("portal_channels.dispatch_now(client_id, channel)", at)
    check(label + ": SMS dispatched after the commit, before the answer",
          nxt < CONV.index("return jsonify({\"ok\": True", at), label)
check("dispatch_now used exactly in the two reply routes",
      CONV.count("portal_channels.dispatch_now(client_id, channel)") == 2)
APP = src("app.py")
check("app registers both SMS blueprints", "aux_app.register_blueprint(portal_sms_bp)" in APP
      and "aux_app.register_blueprint(portal_sms_public_bp)" in APP)
MOD = src("portal_sms.py")
check("every table read is tenant-scoped; queue via portal_cp_outbox",
      MOD.count("WHERE client_id = %s") == 4
      and "portal_cp_outbox.pending(cur, client_id, CHANNEL, PREFIX, limit)" in MOD, MOD.count("WHERE client_id = %s"))
ddl = MOD[MOD.index("def _ensure_ddl"):MOD.index("def default_settings")]
check("the SMS log never stores a message body", "body" not in ddl.lower())
check("opt-outs use the shared compliance check", "portal_compliance.is_opted_out(cur, client_id, contact)" in MOD)
check("inbound refuses unsigned imports without keys", MOD.index("if not twilio_ready(_keys()):")
      < MOD.index("portal_cp_outbox.ingest(client_id, CHANNEL"))
check("status callbacks never trusted without keys",
      "if not sid or status not in STATUS_RANK or not twilio_ready(_keys()):" in MOD)

print("== tick throttle + dispatch ==")
started = []


class NoThread:
    def __init__(self, target=None, args=(), name="", daemon=False):
        started.append(args)

    def start(self):
        pass


real_thread = S.threading.Thread
S.threading.Thread = NoThread
check("kick: first call starts, a second while it runs does not",
      S.kick(7) is True and S.kick(7) is False and started == [(7,)])
S._RUNNING.clear()
check("kick: finished, but inside the poll window -> no new run", S.kick(7) is False and started == [(7,)])
S._RUNNING.clear()
check("kick: other workspace independent; bad ids ignored",
      S.kick("8") is True and S.kick(0) is False and S.kick("x") is False and S.kick(None) is False)
S.ENABLED = False
S._LAST.clear()
S._RUNNING.clear()
check("kick: OF_SMS_CHANNEL=0 -> never", S.kick(9) is False)
check("send: off -> reason off", S.send_pending(9)["reason"] == "off")
S.ENABLED = True
S.threading.Thread = real_thread
S._LAST.clear()
S._RUNNING.clear()
calls = []
real_send = S.send_pending
S.send_pending = lambda cid, limit=0: calls.append((cid, limit)) or {}
portal_channels.dispatch_now("7", "whatsapp")
portal_channels.dispatch_now("7", "email")
portal_channels.dispatch_now("7", "sms")
check("dispatch_now: only sms, small batch", calls == [(7, S.DISPATCH_LIMIT)], calls)
S.send_pending = lambda cid, limit=0: 1 / 0
portal_channels.dispatch_now(7, "sms")
check("dispatch_now never raises", True)
S.send_pending = real_send

print("== HTTP guards (no database touched) ==")
app = Flask(__name__)
app.register_blueprint(S.bp)
app.register_blueprint(S.public_bp)
client = app.test_client()
URL = "/api/v1/portal/channels/sms"
current_p = {"p": None, "exc": None}


def fake_auth():
    if current_p["exc"]:
        raise current_p["exc"]
    return current_p["p"]


S.authenticate_portal_request = fake_auth
db_calls = []
real_conn = portal_db._conn
portal_db._conn = lambda: db_calls.append(1) or (_ for _ in ()).throw(RuntimeError("db down"))
owner = {"client_id": 7, "user_id": 1, "role": "owner", "via_api_key": False}
check("no session -> 401", client.get(URL).status_code == 401 and client.put(URL, json={}).status_code == 401
      and client.post(URL + "/test").status_code == 401)
current_p["exc"] = PortalAuthUnavailable("auth down")
check("auth unavailable -> 503", client.get(URL).status_code == 503)
current_p["exc"] = None
current_p["p"] = dict(owner, via_api_key=True)
check("API key -> 403 everywhere", all(r.status_code == 403 for r in (
    client.get(URL), client.put(URL, json={"enabled": True}), client.post(URL + "/test", json={}))))
current_p["p"] = dict(owner, role="agent")
check("non-editor: save and test -> 403", client.put(URL, json={"enabled": True}).status_code == 403
      and client.post(URL + "/test", json={"to": "+923001234567"}).get_json()["error"]["code"] == "forbidden")
current_p["p"] = owner
for label, payload, needle in (("enabled not a bool", {"enabled": "yes"}, "true or false"),
                               ("limit 0", {"daily_limit": 0}, "whole number"),
                               ("limit over the platform max", {"daily_limit": 501}, "1 to 500"),
                               ("limit bool", {"daily_limit": True}, "whole number"),
                               ("limit text", {"daily_limit": "5"}, "whole number"),
                               ("limit float", {"daily_limit": 2.5}, "whole number"),
                               ("nothing", {"other": 1}, "Nothing to save")):
    r = client.put(URL, json=payload)
    check("PUT refused: " + label, r.status_code == 400 and needle in r.get_json()["error"]["message"],
          r.get_json())
check("PUT without a JSON object -> 400", client.put(URL, data="nope", content_type="application/json")
      .status_code == 400)
for bad in ("03001234567", "+92 300 1234567", "", "+0123456789", None):
    r = client.post(URL + "/test", json={"to": bad})
    check("test refused: " + repr(bad), r.status_code == 400 and "+923001234567" in r.get_json()["error"]["message"])
S.ENABLED = False
check("platform switch off: test -> 409 disabled",
      client.post(URL + "/test", json={"to": "+923001234567"}).get_json()["error"]["code"] == "disabled")
S.ENABLED = True
check("refused requests never reach the database", not db_calls)
for method, url, body in (("get", URL, None), ("put", URL, {"daily_limit": 5}),
                          ("post", URL + "/test", {"to": "+923001234567"})):
    response = getattr(client, method)(url, json=body)
    check(method.upper() + " " + url + ": database down -> 503 without internals",
          response.status_code == 503 and response.get_json()["error"]["code"] == "portal_unavailable"
          and "db down" not in json.dumps(response.get_json()), response.get_json())
res = S.send_pending(7)
check("send with the database down: never raises, reason unavailable",
      res["reason"] == "unavailable" and res["error"] and not res["ran"], res)

IN = "/api/v1/public/sms/incoming"
ST = "/api/v1/public/sms/status"


def post_signed(path, form, token="tok"):
    return client.post(path, data=form, headers={"X-Twilio-Signature": sign(token, BASE + path, form)})


FORM = {"From": "+923001234567", "To": "+14155550100", "MessageSid": "SM" + "1" * 32, "Body": "Salam"}
db_calls.clear()
check("unsigned inbound / status -> 403", client.post(IN, data=FORM).status_code == 403
      and client.post(ST, data={"MessageSid": "SMx", "MessageStatus": "delivered"}).status_code == 403)
check("wrong token -> 403", post_signed(IN, FORM, "other").status_code == 403)
for label, change in (("short code sender", {"From": "8080"}), ("alphanumeric sender", {"From": "BANK"}),
                      ("no sid", {"MessageSid": ""}), ("empty body", {"Body": " "})):
    r = post_signed(IN, dict(FORM, **change))
    check("ignored (empty TwiML): " + label, r.status_code == 200 and r.mimetype == "text/xml"
          and "<Response></Response>" in r.get_data(as_text=True))
S.ENABLED = False
check("platform switch off: inbound answered, ignored", post_signed(IN, FORM).status_code == 200)
S.ENABLED = True
r = post_signed(ST, {"MessageSid": "SMx", "MessageStatus": "teleported"})
check("unknown delivery status -> 204", r.status_code == 204)
check("ignored webhooks never reach the database", not db_calls)
r = post_signed(IN, FORM)
check("database down on a real inbound -> 503 without internals (Twilio may retry)",
      r.status_code == 503 and "db down" not in r.get_data(as_text=True))
r = post_signed(ST, {"MessageSid": "SMx", "MessageStatus": "delivered"})
check("database down on a status callback -> 503", r.status_code == 503)
KEY_STATE["keys"] = {"account_sid": "", "auth_token": "", "from_number": ""}
db_calls.clear()
check("no platform keys: unsigned inbound accepted by the guard but never imported",
      client.post(IN, data=FORM).status_code == 200 and not db_calls)
check("no platform keys: status callback ignored", client.post(
    ST, data={"MessageSid": "SMx", "MessageStatus": "delivered"}).status_code == 204 and not db_calls)
KEY_STATE["keys"] = dict(KEYS)
portal_db._conn = real_conn


def run_db():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="sms244_")
    server = pgserver.get_server(data, cleanup_mode="stop")  # noqa: F841
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()

    def connect():
        return psycopg2.connect(host=data, dbname="postgres", user="postgres")

    def sql(query, args=(), fetch=True):
        c = connect()
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
    import portal_identity
    import portal_compliance
    c = portal_db._conn()
    with c.cursor() as cur:
        portal_events._ensure_ddl(cur)
        portal_identity._ensure_ddl(cur)
        portal_voice._ensure_client_settings(cur)
        for cid, number in ((7, "+14155550100"), (8, "+14155550188")):
            portal_voice._save_voice_settings(cur, cid, dict(portal_voice.default_voice_settings(),
                                                             number=number))
        portal_identity.resolve(cur, 7, "whatsapp", "923001234567", "Ali Khan", create=True)
    c.commit()
    portal_compliance._ensure_compliance_tables(c)
    c.commit()
    c.close()
    connector_api._ensure_away_table()

    r = client.get(URL)
    fresh = r.get_json()
    check("fresh db: GET 200 with defaults and the workspace number",
          r.status_code == 200 and fresh["enabled"] is False and fresh["daily_limit"] == 100
          and fresh["daily_max"] == 500 and fresh["number"] == "+14155550100" and fresh["twilio_ready"] is True
          and fresh["sent_today"] == 0 and fresh["recent"] == [] and fresh["can_edit"] is True
          and fresh["available"] is True and fresh["max_segments"] == 4, fresh)
    check("fresh db: reading creates nothing", sql("SELECT to_regclass('portal_sms_log')")[0] == (None,))

    KEY_STATE["keys"] = {"account_sid": "", "auth_token": "", "from_number": ""}
    r = client.put(URL, json={"enabled": True})
    check("enable without platform keys -> 409 not_ready", r.status_code == 409
          and r.get_json()["error"]["code"] == "not_ready" and "platform admin" in r.get_json()["error"]["message"])
    KEY_STATE["keys"] = dict(KEYS)
    current_p["p"] = dict(owner, client_id=9)
    r = client.put(URL, json={"enabled": True})
    check("enable without an assigned number -> 409", r.status_code == 409
          and "No phone number" in r.get_json()["error"]["message"])
    current_p["p"] = owner
    S.ENABLED = False
    check("enable while the platform switch is off -> 409 disabled",
          client.put(URL, json={"enabled": True}).get_json()["error"]["code"] == "disabled")
    S.ENABLED = True
    check("refused enables saved nothing", client.get(URL).get_json()["enabled"] is False)
    r = client.put(URL, json={"enabled": True, "daily_limit": 3})
    body = r.get_json()
    check("enable: 200 with state", r.status_code == 200 and body["ok"] is True and body["enabled"] is True
          and body["daily_limit"] == 3, body)
    check("enable audited", sql("SELECT note FROM portal_action_log WHERE client_id = 7"
                                " AND action = 'settings.sms_channel'") == [("SMS channel on, daily limit 3",)])
    check("settings stored under client_settings.sms_channel, voice settings kept", sql(
        "SELECT settings -> 'sms_channel' ->> 'enabled', settings -> 'voice_ai' ->> 'number'"
        " FROM client_settings WHERE client_id = 7")[0] == ("true", "+14155550100"))

    print("== inbound ==")
    brain_calls = []
    import portal_brain
    real_answer = portal_brain.maybe_answer

    def brain(client_id, conversation_id, contact_id, contact_name, body, conn):
        brain_calls.append((client_id, contact_id, body))
        with conn.cursor() as cur:
            cur.execute("INSERT INTO portal_connector_commands (client_id, channel, action, payload, status)"
                        " VALUES (%s, %s, 'send_message', %s::jsonb, 'pending')",
                        (client_id, portal_channels.channel_for_contact(contact_id),
                         json.dumps({"external_user_id": contact_id, "body": "Ji, order kal pohanch jayega.",
                                     "source": "ai_brain"})))
        return True

    portal_brain.maybe_answer = brain
    TW["calls"].clear()
    TW["n"] = 0
    r = post_signed(IN, FORM)
    check("signed inbound: 200 empty TwiML", r.status_code == 200
          and "<Response></Response>" in r.get_data(as_text=True))
    conv = sql("SELECT id, contact_id FROM portal_conversations WHERE client_id = 7 AND channel = 'sms'")
    check("conversation on the sms channel with the sender's number",
          len(conv) == 1 and conv[0][1] == "sms:+923001234567", conv)
    check("brain consulted once, for the customer", brain_calls == [(7, "sms:+923001234567", "Salam")], brain_calls)
    check("the AI reply went out by SMS in the same request, from the workspace number",
          len(TW["calls"]) == 1 and TW["calls"][0][1] == "/Messages.json"
          and TW["calls"][0][2] == {"To": "+923001234567", "From": "+14155550100",
                                    "Body": "Ji, order kal pohanch jayega.",
                                    "StatusCallback": BASE + S.STATUS_PATH}, TW["calls"])
    msgs = sql("SELECT direction, body FROM portal_messages WHERE conversation_id = %s ORDER BY id", (conv[0][0],))
    check("conversation shows the customer's text and the sent reply",
          msgs == [("in", "Salam"), ("out", "Ji, order kal pohanch jayega.")], msgs)
    check("command done with the Twilio message id", sql(
        "SELECT status, provider_message_id FROM portal_connector_commands WHERE client_id = 7"
        " AND channel = 'sms'") == [("done", "SM%032d" % 1)])
    log = sql("SELECT direction, contact_id, sid, status, segments, source FROM portal_sms_log"
              " WHERE client_id = 7 ORDER BY id")
    check("log: one in, one out (no bodies)", log == [
        ("in", "sms:+923001234567", "SM" + "1" * 32, "received", 1, "customer"),
        ("out", "sms:+923001234567", "SM%032d" % 1, "queued", 1, "ai_brain")], log)
    check("identity: the SMS number is the same person as on WhatsApp", sql(
        "SELECT COUNT(DISTINCT identity_id) FROM portal_identity_handles WHERE client_id = 7"
        " AND handle = '923001234567' AND channel IN ('phone', 'whatsapp')")[0][0] == 1
          and sql("SELECT COUNT(*) FROM portal_identities WHERE client_id = 7")[0][0] == 1)
    state = client.get(URL).get_json()
    check("state: last in / last sent set, sent today 1, error clear",
          state["last_in_at"] and state["last_sent_at"] and state["sent_today"] == 1
          and state["last_error"] == "", state)
    check("recent: newest first, masked contact, no body", [
        (x["direction"], x["contact"], x["source"]) for x in state["recent"]]
          == [("out", "...4567", "ai_brain"), ("in", "...4567", "customer")]
          and "body" not in state["recent"][0] and "+923001234567" not in json.dumps(state), state["recent"])

    TW["calls"].clear()
    r = post_signed(IN, FORM)
    check("Twilio retry of the same MessageSid: nothing duplicated, nothing sent",
          r.status_code == 200 and sql("SELECT COUNT(*) FROM portal_messages WHERE conversation_id = %s",
                                       (conv[0][0],))[0][0] == 2
          and len(brain_calls) == 1 and TW["calls"] == []
          and sql("SELECT COUNT(*) FROM portal_sms_log WHERE direction = 'in'")[0][0] == 1)
    for label, form in (("unassigned number", dict(FORM, To="+14155550999", MessageSid="SM" + "2" * 32)),
                        ("workspace with SMS off", dict(FORM, To="+14155550188", MessageSid="SM" + "3" * 32))):
        r = post_signed(IN, form)
        check("ignored: " + label, r.status_code == 200 and sql(
            "SELECT COUNT(*) FROM portal_conversations WHERE channel = 'sms'")[0][0] == 1 and len(brain_calls) == 1)
    portal_brain.maybe_answer = lambda *args, **kw: None
    r = post_signed(IN, dict(FORM, From="+923007778888", MessageSid="SM" + "5" * 32, Body="Price?"))
    check("a new SMS sender gets its own identity with a phone handle", r.status_code == 200 and sql(
        "SELECT channel FROM portal_identity_handles WHERE client_id = 7 AND handle = '923007778888'"
        " ORDER BY channel") == [("phone",), ("whatsapp",)])

    print("== laptop bridges never see SMS work ==")
    contact = "sms:+923001234567"

    def queue(client_id, action, payload, channel="sms"):
        return sql("INSERT INTO portal_connector_commands (client_id, channel, action, payload, status)"
                   " VALUES (%s, %s, %s, %s::jsonb, 'pending') RETURNING id",
                   (client_id, channel, action, json.dumps(payload)))[0][0]

    long_body = " ".join("lafz%d" % i for i in range(300))
    manual_id = queue(7, "send_message", {"external_user_id": contact, "body": "Ji, kal deliver hoga.",
                                          "source": "manual"})
    long_id = queue(7, "send_message", {"external_user_id": contact, "body": long_body, "source": "ai_brain"})
    media_id = queue(7, "send_media", {"external_user_id": contact, "asset_id": 4})
    foreign_id = queue(8, "send_message", {"external_user_id": contact, "body": "w8", "source": "manual"})
    wa_id = queue(7, "send_message", {"external_user_id": "923001234567", "body": "wa"}, channel="whatsapp")
    sql("INSERT INTO portal_away_replies (client_id, conversation_id, contact_id, body)"
        " VALUES (7, NULL, 'sms:+923009998888', 'Hum abhi band hain'),"
        " (7, NULL, '923001112222', 'Hum abhi band hain')", fetch=False)
    capp = Flask("connector")
    capp.register_blueprint(connector_api.bp)
    cclient = capp.test_client()
    headers = {"X-Omniflow-Key": os.environ["OMNIFLOW_SERVICE_KEY"]}
    real_kick = S.kick
    S.kick = lambda cid: False
    import portal_email_channel
    real_email_kick = portal_email_channel.kick
    portal_email_channel.kick = lambda cid: False
    r = cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&limit=50", headers=headers)
    ids = [cmd["id"] for cmd in r.get_json()["commands"]]
    check("unfiltered poll: WhatsApp work yes, SMS commands no",
          r.status_code == 200 and wa_id in ids and not {manual_id, long_id, media_id} & set(ids), ids)
    r = cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&channel=sms", headers=headers)
    check("a bridge asking for channel=sms -> 400", r.status_code == 400, r.status_code)
    r = cclient.get("/api/v1/connector/away-replies?client_id=7&limit=20", headers=headers)
    away_users = [a["external_user_id"] for a in r.get_json()["away_replies"]]
    check("laptop away-reply poll skips SMS contacts", away_users == ["923001112222"], away_users)
    S.kick = real_kick
    portal_email_channel.kick = real_email_kick

    print("== sending ==")
    TW["calls"].clear()
    res = S.send_pending(7)
    check("daily limit 3: one used by the AI reply, two more sent, the rest refused, media refused",
          res["ran"] and res["sent"] == 2 and res["refused"] == 2 and res["failed"] == 0, res)
    bodies = [call[2]["Body"] for call in TW["calls"]]
    check("manual reply sent as written; long reply shortened to 4 parts",
          bodies[0] == "Ji, kal deliver hoga." and bodies[1].endswith("...") and S.segments(bodies[1]) == 4,
          [b[-12:] for b in bodies])
    rows = dict(sql("SELECT id, status FROM portal_connector_commands WHERE client_id IN (7, 8)"))
    check("statuses: sent done, media dead, foreign + WhatsApp untouched",
          rows[manual_id] == "done" and rows[long_id] == "done" and rows[media_id] == portal_events._DEAD
          and rows[foreign_id] == "pending" and rows[wa_id] == "pending", rows)
    check("shortening noted on the command", "shortened to 4 parts" in sql(
        "SELECT result_note FROM portal_connector_commands WHERE id = %s", (long_id,))[0][0])
    check("media refusal reason kept", "text messages only" in sql(
        "SELECT error_message FROM portal_connector_commands WHERE id = %s", (media_id,))[0][0])
    away = sql("SELECT contact_id, status, result_note FROM portal_away_replies WHERE client_id = 7 ORDER BY id")
    check("SMS away reply refused by the daily limit; WhatsApp away reply left to the laptop",
          away[0][:2] == ("sms:+923009998888", "failed") and "Daily SMS limit reached (3)" in away[0][2]
          and away[1][1] == "pending", away)
    check("log counts today's texts", sql("SELECT COUNT(*) FROM portal_sms_log WHERE client_id = 7"
                                          " AND direction = 'out'")[0][0] == 3)

    client.put(URL, json={"daily_limit": 50})
    print("== Twilio errors ==")
    retry_id = queue(7, "send_message", {"external_user_id": contact, "body": "retry me"})
    TW["script"] = [err(503, "Service unavailable")]
    res = S.send_pending(7)
    row = sql("SELECT status, attempts, next_attempt_at > NOW() FROM portal_connector_commands WHERE id = %s",
              (retry_id,))[0]
    check("Twilio 5xx: retried later (attempt spent, back off)", res["failed"] == 1 and row == ("pending", 1, True),
          (res, row))
    sql("UPDATE portal_connector_commands SET status = 'dead' WHERE id = %s", (retry_id,), fetch=False)
    bad_id = queue(7, "send_message", {"external_user_id": "sms:+15005550001", "body": "x"})
    TW["script"] = [err(400, "The 'To' number +15005550001 is not a valid phone number.")]
    res = S.send_pending(7)
    check("Twilio 400: refused, never retried", res["refused"] == 1 and sql(
        "SELECT status, error_message FROM portal_connector_commands WHERE id = %s", (bad_id,))[0]
          == (portal_events._DEAD, "Twilio: The 'To' number +15005550001 is not a valid phone number."))
    auth_id = queue(7, "send_message", {"external_user_id": contact, "body": "auth"})
    TW["script"] = [err(401, "Authenticate")]
    res = S.send_pending(7)
    row = sql("SELECT status, attempts FROM portal_connector_commands WHERE id = %s", (auth_id,))[0]
    check("Twilio 401: nothing spent, the owner sees why", row == ("pending", 0)
          and "refused the platform keys" in res["error"]
          and "refused the platform keys" in client.get(URL).get_json()["last_error"], (row, res))
    KEY_STATE["keys"] = {"account_sid": "", "auth_token": "", "from_number": ""}
    TW["calls"].clear()
    res = S.send_pending(7)
    check("keys missing: replies wait, owner told", TW["calls"] == [] and "Twilio keys missing" in res["error"]
          and sql("SELECT status FROM portal_connector_commands WHERE id = %s", (auth_id,))[0][0] == "pending")
    KEY_STATE["keys"] = dict(KEYS)
    c = portal_db._conn()
    with c.cursor() as cur:
        portal_voice._save_voice_settings(cur, 7, dict(portal_voice.default_voice_settings(), number=""))
    c.commit()
    c.close()
    res = S.send_pending(7)
    check("number unassigned: replies wait, owner told", TW["calls"] == [] and "No phone number" in res["error"])
    c = portal_db._conn()
    with c.cursor() as cur:
        portal_voice._save_voice_settings(cur, 7, dict(portal_voice.default_voice_settings(),
                                                       number="+14155550100"))
    c.commit()
    c.close()
    res = S.send_pending(7)
    check("fixed: the waiting reply goes out and the error clears", res["sent"] == 1 and res["error"] == ""
          and client.get(URL).get_json()["last_error"] == "", res)

    print("== opt-out ==")
    portal_brain.maybe_answer = lambda *args, **kw: None
    r = post_signed(IN, dict(FORM, MessageSid="SM" + "4" * 32, Body="STOP"))
    check("STOP by SMS recorded as an opt-out", r.status_code == 200 and sql(
        "SELECT reason FROM portal_optouts WHERE client_id = 7 AND contact_id = %s", (contact,)) == [("customer",)])
    stop_id = queue(7, "send_message", {"external_user_id": contact, "body": "Offer!"})
    TW["calls"].clear()
    res = S.send_pending(7)
    check("opted-out customer never texted", TW["calls"] == [] and res["refused"] == 1 and "opt-out" in sql(
        "SELECT error_message FROM portal_connector_commands WHERE id = %s", (stop_id,))[0][0])
    sql("DELETE FROM portal_optouts WHERE client_id = 7", fetch=False)

    print("== delivery callbacks ==")
    sid = sql("SELECT sid FROM portal_sms_log WHERE client_id = 7 AND direction = 'out' AND source = 'manual'")[0][0]
    for status, code, want in (("delivered", "", ("delivered", "")), ("sent", "", ("delivered", "")),
                               ("undelivered", "30003", ("undelivered", "30003"))):
        r = post_signed(ST, {"MessageSid": sid, "MessageStatus": status, "ErrorCode": code})
        check("status " + status + " -> " + want[0], r.status_code == 204 and sql(
            "SELECT status, error_code FROM portal_sms_log WHERE sid = %s", (sid,))[0] == want)
    post_signed(ST, {"MessageSid": "SM" + "1" * 32, "MessageStatus": "failed"})
    check("inbound rows are never changed by callbacks", sql(
        "SELECT status FROM portal_sms_log WHERE sid = %s", ("SM" + "1" * 32,))[0][0] == "received")
    r = post_signed(ST, {"MessageSid": "SMunknown", "MessageStatus": "delivered"})
    check("unknown sid -> 204, nothing changed", r.status_code == 204)
    state = client.get(URL).get_json()
    check("card shows the delivery error code", any(x["status"] == "undelivered" and x["error_code"] == "30003"
                                                   for x in state["recent"]), state["recent"])

    print("== test message ==")
    TW["calls"].clear()
    r = client.post(URL + "/test", json={"to": "+923331234567"})
    check("test: 200, sent from the workspace number with the test text", r.status_code == 200
          and r.get_json() == {"ok": True, "status": "queued"} and TW["calls"][0][2]["Body"] == S.TEST_TEXT
          and TW["calls"][0][2]["From"] == "+14155550100" and TW["calls"][0][2]["To"] == "+923331234567")
    check("test audited with a masked number", sql(
        "SELECT note FROM portal_action_log WHERE client_id = 7 AND action = 'settings.sms_channel'"
        " ORDER BY id DESC LIMIT 1") == [("SMS test message sent to ...4567",)])
    r = client.post(URL + "/test", json={"to": "+923331234567"})
    check("second test within a minute -> 429", r.status_code == 429 and len(TW["calls"]) == 1)
    sql("UPDATE portal_sms_log SET created_at = created_at - INTERVAL '61 seconds' WHERE source = 'test'", fetch=False)
    TW["script"] = [err(400, "21608 unverified number")]
    r = client.post(URL + "/test", json={"to": "+923331234567"})
    check("Twilio refuses the test -> 409 with its message, nothing logged", r.status_code == 409
          and r.get_json()["error"]["message"] == "Twilio: 21608 unverified number"
          and sql("SELECT COUNT(*) FROM portal_sms_log WHERE source = 'test'")[0][0] == 1)
    TW["script"] = [err(500, "down")]
    check("Twilio down on the test -> 503", client.post(URL + "/test", json={"to": "+923331234567"})
          .status_code == 503)
    client.put(URL, json={"daily_limit": 1})
    r = client.post(URL + "/test", json={"to": "+923331234567"})
    check("daily limit reached -> 429", r.status_code == 429 and "limit" in r.get_json()["error"]["message"])
    client.put(URL, json={"daily_limit": 50})
    current_p["p"] = dict(owner, client_id=9)
    check("test without a number -> 409 not_ready", client.post(URL + "/test", json={"to": "+923331234567"})
          .get_json()["error"]["code"] == "not_ready")
    current_p["p"] = owner

    print("== lock + switch off ==")
    hold = connect()
    hold.cursor().execute("SELECT pg_advisory_lock(%s, %s)", (S.LOCK_CLASS, 7))
    lock_id = queue(7, "send_message", {"external_user_id": contact, "body": "lock"})
    TW["calls"].clear()
    res = S.send_pending(7)
    check("another sender holds the workspace lock -> busy, nothing sent",
          res["reason"] == "busy" and not res["ran"] and TW["calls"] == [], res)
    hold.close()
    other = S.send_pending(8)
    check("foreign workspace (SMS off): its reply refused, not ours",
          other["refused"] == 1 and sql("SELECT status FROM portal_connector_commands WHERE id = %s",
                                        (foreign_id,))[0][0] == portal_events._DEAD
          and "switched off" in sql("SELECT error_message FROM portal_connector_commands WHERE id = %s",
                                    (foreign_id,))[0][0])
    r = client.put(URL, json={"enabled": False})
    check("switch off: 200, error cleared", r.status_code == 200 and r.get_json()["enabled"] is False
          and r.get_json()["last_error"] == "")
    res = S.send_pending(7)
    check("switched off: queued reply refused with the reason (not left waiting)", res["refused"] == 1
          and "switched off" in sql("SELECT error_message FROM portal_connector_commands WHERE id = %s",
                                    (lock_id,))[0][0] and TW["calls"] == [])
    check("logs and settings stay tenant-scoped", sql("SELECT COUNT(*) FROM portal_sms_log WHERE client_id = 8")
          [0][0] == 0)
    portal_brain.maybe_answer = real_answer

    print("== admin: connect SMS ==")
    import admin_providers
    admin_app = Flask("admin-sms")
    admin_app.register_blueprint(admin_providers.bp)
    admin = admin_app.test_client()
    H = {"X-Omniflow-Key": os.environ["OMNIFLOW_SERVICE_KEY"]}
    connected = {"voice": [], "sms": []}
    real_get = portal_voice.get_twilio_number
    real_cv = portal_voice.connect_twilio_number
    real_cs = portal_voice.connect_twilio_sms
    real_list = portal_voice.list_twilio_numbers
    current = {"n": dict(num)}
    portal_voice.get_twilio_number = lambda keys, sid: dict(current["n"], sid=sid)
    portal_voice.connect_twilio_number = lambda keys, sid, base: connected["voice"].append(sid) or {}
    portal_voice.connect_twilio_sms = lambda keys, sid, base: (
        connected["sms"].append((sid, base)) or dict(current["n"], sid=sid, sms_url=base + S.INCOMING_PATH))
    PN = "PN" + "a" * 32
    r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H, json={"sid": PN, "what": "fax"})
    check("what must be voice or sms -> 400", r.status_code == 400 and not connected["sms"])
    current["n"] = dict(num, capabilities={"voice": True, "sms": False})
    r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H, json={"sid": PN, "what": "sms"})
    check("number without SMS -> 409 not_sms_capable", r.status_code == 409
          and r.get_json()["error"]["code"] == "not_sms_capable" and not connected["sms"])
    current["n"] = dict(num, sms_application_sid="AP" + "c" * 32)
    r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H, json={"sid": PN, "what": "sms"})
    check("SMS held by a TwiML app -> 409 number_in_use", r.status_code == 409
          and r.get_json()["error"]["code"] == "number_in_use" and not connected["sms"])
    current["n"] = dict(num, voice_application_sid="AP" + "d" * 32)
    r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H, json={"sid": PN, "what": "SMS"})
    body = r.get_json()
    check("SMS connect works even when voice uses an app; voice untouched",
          r.status_code == 200 and connected["sms"] == [(PN, BASE)] and connected["voice"] == []
          and body["number"]["sms_state"] == "connected", body)
    check("SMS connect audited separately (last 4 digits only)", sql(
        "SELECT note FROM portal_action_log WHERE client_id = 0 AND action = 'voice.twilio_sms_connected'")
          == [("Twilio number ...0100 -> cp.example.com (env)",)])
    r = admin.post("/api/v1/admin/voice/twilio/connect", headers=H, json={"sid": PN})
    check("default what stays voice (app number still refused for voice)", r.status_code == 409
          and connected["voice"] == [] and "TwiML app" in r.get_data(as_text=True))
    portal_voice.list_twilio_numbers = lambda keys: ([dict(num, sms_url=BASE + S.INCOMING_PATH)], False)
    r = admin.get("/api/v1/admin/voice/twilio", headers=H)
    body = r.get_json()
    check("list carries the SMS address and per-number SMS state", r.status_code == 200
          and body["sms_url"] == BASE + S.INCOMING_PATH and body["numbers"][0]["sms_state"] == "connected"
          and body["numbers"][0]["sms_capable"] is True and "tok" not in r.get_data(as_text=True), body)
    portal_voice.get_twilio_number = real_get
    portal_voice.connect_twilio_number = real_cv
    portal_voice.connect_twilio_sms = real_cs
    portal_voice.list_twilio_numbers = real_list


run_db()
summary("sms channel")
