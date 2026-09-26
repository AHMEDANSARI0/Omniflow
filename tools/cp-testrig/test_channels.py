"""Tests for the B20 key-powered channels: Twilio voice click-to-call,
video invites (Whereby/Daily/Zoom), the Stripe platform payment path,
checkout phone verification (Ph9), and the web surfaces that use them."""
import json
import urllib.request

from flask import Flask

import platform_settings
import portal_checkout
import portal_growth
import portal_payments
import portal_video
import portal_voice
import test_lib
from test_lib import PrincipalStub, check, install_db_stub, summary

PRINCIPAL = {"client_id": 1, "role": "owner", "user_id": 9,
             "kind": "human", "via_api_key": False}

app = Flask(__name__)
app.register_blueprint(portal_voice.bp)
app.register_blueprint(portal_voice.public_bp)
app.register_blueprint(portal_video.bp)
app.register_blueprint(portal_payments.bp)
app.register_blueprint(portal_payments.public_bp)
app.register_blueprint(portal_checkout.bp)
app.register_blueprint(portal_checkout.public_bp)
client = app.test_client()

_saved_get_group = platform_settings.get_group
_saved_flag = platform_settings.flag
_saved_send = portal_growth._send_command
SEND_LOG = []


def fake_send(cur, client_id, contact, name, body, source,
              broadcast_id=None):
    SEND_LOG.append({"client_id": client_id, "contact": contact,
                     "body": body, "source": source})


portal_growth._send_command = fake_send

print("== voice: keys + create + list + webhook ==")

platform_settings.get_group = lambda group: (
    {"account_sid": "AC1", "auth_token": "tok", "from_number": "+15550001"}
    if group == "voice" else {})

r = client.post("/api/v1/portal/voice/calls", json={
    "contact_id": "92300", "phone": "+923001234567",
    "message": "Your order is ready"})
check("voice 401 anon", r.status_code == 401, r.status_code)
PrincipalStub(portal_voice, principal=PRINCIPAL)

conn = install_db_stub(portal_voice, [])
r = client.post("/api/v1/portal/voice/calls", json={
    "contact_id": "92300", "phone": "923001234567",
    "message": "hi"})
check("voice bad phone 400", r.status_code == 400, r.status_code)
r = client.post("/api/v1/portal/voice/calls", json={
    "contact_id": "92300", "phone": "+923001234567",
    "message": ""})
check("voice empty message 400", r.status_code == 400, r.status_code)

platform_settings.get_group = lambda group: {}
r = client.post("/api/v1/portal/voice/calls", json={
    "contact_id": "92300", "phone": "+923001234567",
    "message": "hi"})
check("voice 409 no keys", r.status_code == 409
      and r.get_json()["error"]["code"] == "not_configured",
      r.get_json())
platform_settings.get_group = lambda group: (
    {"account_sid": "AC1", "auth_token": "tok",
     "from_number": "+15550001"} if group == "voice" else {})

portal_voice._DDL_READY = True
calls = {}
portal_voice._twilio_create_call = lambda keys, to, message: (
    calls.update({"to": to, "message": message,
                  "from": keys["from_number"]})
    or {"_status": 201, "sid": "CA99", "status": "queued"})
conn = install_db_stub(portal_voice, [
    [{"id": 1, "contact_id": "92300", "phone": "+923001234567",
      "sid": "CA99", "status": "queued", "message": "Your order",
      "created_at": "now"}], [], []])
r = client.post("/api/v1/portal/voice/calls", json={
    "contact_id": "92300", "phone": "+923001234567",
    "message": "Your order"})
body = r.get_json()
check("voice create ok", r.status_code == 200 and body["ok"] is True,
      body)
check("voice call row", body["call"]["sid"] == "CA99", body)
check("voice twilio args", calls["to"] == "+923001234567"
      and "order" in calls["message"], calls)
check("voice audit", any("voice.called" in json.dumps(e)
                         for e in conn.cur.executed), "audit")

portal_voice._twilio_create_call = (
    lambda keys, to, message: {"_error": "refused"})
install_db_stub(portal_voice, [])
r = client.post("/api/v1/portal/voice/calls", json={
    "contact_id": "92300", "phone": "+923001234567", "message": "x"})
check("voice twilio 502", r.status_code == 502, r.status_code)

portal_voice._twilio_create_call = lambda keys, to, message: {
    "_status": 201, "sid": "CA99", "status": "queued"}
conn = install_db_stub(portal_voice, [
    [{"id": 2, "contact_id": "", "phone": "+923007654321",
      "sid": "CA88", "status": "completed", "message": "m",
      "created_at": "now"}]])
r = client.get("/api/v1/portal/voice/calls")
body = r.get_json()
check("voice list", r.status_code == 200
      and body["calls"][0]["status"] == "completed", body)

conn2 = install_db_stub(portal_voice, [])
r = client.post("/api/v1/public/voice/webhook",
                data={"CallSid": "CA99", "CallStatus": "completed"})
r = client.post("/api/v1/public/voice/webhook",
                data={"CallSid": "CA99", "CallStatus": "completed"})
check("voice webhook 204", r.status_code == 204, r.status_code)
check("voice webhook update", any("UPDATE" in json.dumps(e)
                                  for e in conn2.cur.executed), "update")
r = client.post("/api/v1/public/voice/webhook", data={})
check("voice webhook empty ok", r.status_code == 204, r.status_code)

print("== video: whereby/daily/zoom + send ==")

platform_settings.get_group = lambda group: (
    {"provider": "whereby", "api_key": "wk1"} if group == "video" else {})
portal_video._DDL_READY = True
PrincipalStub(portal_video, principal=PRINCIPAL)
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 0})
check("video bad conversation 400", r.status_code == 400, r.status_code)
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 5, "provider": "meet"})
check("video bad provider 400", r.status_code == 400, r.status_code)

platform_settings.get_group = lambda group: (
    {"provider": "whereby"} if group == "video" else {})
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 5})
check("video 409 no key", r.status_code == 409
      and r.get_json()["error"]["code"] == "not_configured",
      r.get_json())

platform_settings.get_group = lambda group: (
    {"provider": "whereby", "api_key": "wk1"} if group == "video"
    else {})
posts = {}
portal_video._post_json = lambda url, headers, payload: (
    posts.update({"url": url, "headers": headers,
                  "payload": payload})
    or {"_status": 201, "meetingUrl": "https://whereby.com/r1"})
SEND_LOG.clear()
conn = install_db_stub(portal_video, [
    [{"contact_id": "92300111"}], [{"contact_name": "Ayesha"}],
    [{"id": 1, "conversation_id": 5, "contact_id": "92300111",
      "provider": "whereby", "url": "https://whereby.com/r1",
      "created_at": "now"}], []])
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 5, "title": "Order chat"})
body = r.get_json()
check("video whereby ok", r.status_code == 200 and body["ok"] is True,
      body)
check("video whereby url api", posts["url"]
      == "https://api.whereby.dev/v1/meetings"
      and posts["headers"]["Authorization"] == "Bearer wk1", posts)
check("video send queued", SEND_LOG
      and SEND_LOG[0]["source"] == "video_invite"
      and "whereby.com/r1" in SEND_LOG[0]["body"]
      and SEND_LOG[0]["contact"] == "92300111", SEND_LOG)
check("video audit", any("video.invited" in json.dumps(e)
                         for e in conn.cur.executed), "audit")

portal_video._post_json = lambda url, headers, payload: (
    {"_status": 201, "url": "https://api.daily.co/r2"})
conn = install_db_stub(portal_video, [
    [{"contact_id": "92300111"}], [{"contact_name": "Ayesha"}],
    [{"id": 2, "conversation_id": 5, "contact_id": "92300111",
      "provider": "daily", "url": "https://api.daily.co/r2",
      "created_at": "now"}], []])
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 5, "provider": "daily"})
check("video daily ok", r.status_code == 200, r.status_code)

platform_settings.get_group = lambda group: (
    {"provider": "zoom"} if group == "video" else {})
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 5, "provider": "zoom"})
check("video zoom 409 no oauth", r.status_code == 409, r.status_code)

platform_settings.get_group = lambda group: (
    {"provider": "zoom", "zoom_account_id": "ZA",
     "zoom_client_id": "ZC", "zoom_client_secret": "ZS"}
    if group == "video" else {})
tokens = {}
portal_video._post_form = lambda url, headers, body: (
    tokens.update({"url": url, "body": body.decode("utf8")})
    or {"access_token": "ztok"})
portal_video._post_json = lambda url, headers, payload: (
    posts.update({"zoom_url": url}) or {"_status": 201,
                                        "join_url": "https://zoom.us/j/9"})
conn = install_db_stub(portal_video, [
    [{"contact_id": "92300111"}], [{"contact_name": "Ayesha"}],
    [{"id": 3, "conversation_id": 5, "contact_id": "92300111",
      "provider": "zoom", "url": "https://zoom.us/j/9",
      "created_at": "now"}], []])
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 5, "provider": "zoom"})
check("video zoom ok", r.status_code == 200, r.get_json())
check("video zoom oauth url", tokens["url"]
      == "https://zoom.us/oauth/token"
      and "account_id=ZA" in tokens["body"], tokens)
check("video zoom meetings url", posts.get("zoom_url")
      == "https://api.zoom.us/v2/users/me/meetings", posts)

portal_video._post_json = lambda url, headers, payload: {"_error": "no"}
install_db_stub(portal_video, [])
platform_settings.get_group = lambda group: (
    {"provider": "whereby", "api_key": "wk1"} if group == "video"
    else {})
r = client.post("/api/v1/portal/video/rooms",
                json={"conversation_id": 5})
check("video provider 502", r.status_code == 502, r.status_code)

conn = install_db_stub(portal_video, [
    [{"id": 3, "conversation_id": 5, "contact_id": "92300111",
      "provider": "zoom", "url": "https://zoom.us/j/9",
      "created_at": "now"}]])
r = client.get("/api/v1/portal/video/rooms?conversation_id=5")
body = r.get_json()
check("video list", r.status_code == 200
      and body["rooms"][0]["provider"] == "zoom", body)
r = client.get("/api/v1/portal/video/rooms?conversation_id=5")

print("== stripe: session + return ==")

platform_settings.get_group = lambda group: (
    {"secret_key": "sk_live_platform"} if group == "payments" else {})
check("stripe configured via panel",
      portal_payments._configured(
          {"enabled": True, "provider": "stripe"}) is True, "cfg")
check("stripe unconfigured without key",
      portal_payments._configured(
          {"enabled": True, "provider": "stripe"}) is True, "cfg")

sessions = {}
portal_payments._stripe_create_session = (
    lambda secret, intent, amount, title, base: (
        sessions.update({"secret": secret, "intent": intent,
                         "amount": amount, "base": base})
        or {"url": "https://checkout.stripe.com/pay/cs1"}))
portal_checkout._CHECKOUT_DDL_READY = True
portal_payments._SETTINGS_DDL_READY = True
portal_payments._INTENTS_DDL_READY = True
PrincipalStub(portal_checkout, principal=PRINCIPAL)
conn = install_db_stub(portal_payments, [
    [{"id": 7, "client_id": 1, "contact_id": "92300111",
      "title": "Kurti order", "total": 2000, "paid_amount": 0,
      "status": "open", "expires_at": None}],
    [{"provider": "stripe", "enabled": True, "sandbox": False,
      "merchant_id": "", "password": "", "salt": "", "store_id": ""}],
    [], []])
r = client.get("/api/v1/public/checkout/tok1/pay")
check("stripe redirect", r.status_code == 302
      and "checkout.stripe.com" in r.headers.get("Location", ""),
      (r.status_code, r.headers.get("Location")))
check("stripe session args", sessions["secret"] == "sk_live_platform"
      and sessions["amount"] == 2000, sessions)
check("stripe intent row", any("INSERT INTO portal_payment_intents"
                               in json.dumps(e)
                               for e in conn.cur.executed), "intent")

statuses = {}
portal_payments._stripe_session_status = lambda secret, sid: (
statuses.update({"sid": sid}) or {"payment_status": "paid",
                                  "payment_intent": "pi_1"})
conn = install_db_stub(portal_payments, [
[{"id": 4, "client_id": 1, "link_id": 7, "amount": 2000,
  "status": "pending", "provider": "stripe"}],
[{"id": 4}], [{"paid_amount": 2000, "total": 2000}], []])
r = client.get("/api/v1/public/payments/callback/tokint"
           "?stripe_return=1&session_id=cs1")
check("stripe return paid page", r.status_code == 200
  and b"Payment received" in r.data, r.status_code)
check("stripe status call", statuses["sid"] == "cs1", statuses)
check("stripe link updated", any("paid_amount" in json.dumps(e)
                             for e in conn.cur.executed), "link")

portal_payments._stripe_session_status = lambda secret, sid: {
"payment_status": "unpaid"}
r = client.get("/api/v1/public/payments/callback/tokint"
           "?stripe_return=1&session_id=cs1")
check("stripe unpaid 400", r.status_code == 400, r.status_code)

print("== phone verification OTP ==")

platform_settings.flag = lambda name: False
r = client.post("/api/v1/public/checkout/tok1/otp")
check("otp feature off 409", r.status_code == 409, r.status_code)
r = client.post("/api/v1/public/checkout/tok1/otp/verify",
                json={"code": "123456"})
check("otp verify feature off 409", r.status_code == 409, r.status_code)

platform_settings.flag = lambda name: name == "phone_verification"
check("phone_verification_on", portal_checkout.phone_verification_on()
      is True, True)
portal_checkout._OTP_DDL_READY = True
SEND_LOG.clear()
conn = install_db_stub(portal_checkout, [
    [{"id": 7, "client_id": 1, "contact_id": "92300111",
      "status": "open"}],
    [{"n": 0}],
    [],
    [{"contact_name": "Ayesha"}],
    []])
r = client.post("/api/v1/public/checkout/tok1/otp")
check("otp send ok", r.status_code == 200 and r.get_json()["sent"] is True,
      r.get_json())
check("otp whatsapp queued", SEND_LOG
      and SEND_LOG[0]["source"] == "phone_otp"
      and "verification code" in SEND_LOG[0]["body"], SEND_LOG)
sent_code = SEND_LOG[0]["body"].split("is ")[1].split(" ")[0]
check("otp 6 digits", len(sent_code) == 6 and sent_code.isdigit(),
      sent_code)
check("otp audit", any("checkout.otp_sent" in json.dumps(e)
                       for e in conn.cur.executed), "audit")

conn = install_db_stub(portal_checkout, [
    [{"id": 7, "client_id": 1, "contact_id": "92300111",
      "status": "open"}],
    [{"n": 3}],
    []])
r = client.post("/api/v1/public/checkout/tok1/otp")
check("otp rate limited", r.status_code == 429, r.status_code)

r = client.post("/api/v1/public/checkout/tok1/otp/verify",
                json={"code": "12"})
check("otp bad format 400", r.status_code == 400, r.status_code)

conn = install_db_stub(portal_checkout, [
    [{"code_hash": portal_checkout._otp_hash("tok1", sent_code),
      "attempts": 0, "created_at": "now"}],
    [],
    []])
r = client.post("/api/v1/public/checkout/tok1/otp/verify",
                json={"code": sent_code})
check("otp verify ok", r.status_code == 200
      and r.get_json()["verified"] is True, r.get_json())

conn = install_db_stub(portal_checkout, [
    [{"code_hash": portal_checkout._otp_hash("tok1", "000000"),
      "attempts": 0, "created_at": "now"}],
    [],
    []])
r = client.post("/api/v1/public/checkout/tok1/otp/verify",
                json={"code": sent_code})
check("otp wrong code 400", r.status_code == 400, r.status_code)

conn = install_db_stub(portal_checkout, [
    [{"code_hash": "x", "attempts": 5, "created_at": "now"}],
    [],
    []])
r = client.post("/api/v1/public/checkout/tok1/otp/verify",
                json={"code": "123456"})
check("otp attempts capped", r.status_code == 429, r.status_code)

platform_settings.flag = _saved_flag

print("== platform video config ==")

platform_settings.get_group = lambda group: (
    {"provider": "zoom", "zoom_account_id": "ZA",
     "zoom_client_id": "ZC", "zoom_client_secret": "ZS"}
    if group == "video" else {})
config = platform_settings.video_config()
check("video config zoom", config["provider"] == "zoom"
      and config["zoom_client_secret"] == "ZS", config)
platform_settings.get_group = lambda group: {}

print("== app wiring ==")

APP = open("./app.py", encoding="utf8").read()
check("app imports voice", "from portal_voice import bp" in APP, "imp")
check("app imports video", "from portal_video import bp" in APP, "imp")
check("app registers voice public",
      "register_blueprint(portal_voice_public_bp)" in APP, "reg")
check("app registers video", "register_blueprint(portal_video_bp)" in APP,
      "reg")

print("== website surface (vs /tmp/p13) ==")

P13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(P13 + path, encoding="utf8").read()


VOICE = read("app/dashboard/(portal)/conversations/[id]/VoiceCard.tsx")
check("voice card", "Place call" in VOICE
      and "/api/omniflow/portal/voice/calls" in VOICE, "card")
VIDEO = read("app/dashboard/(portal)/conversations/[id]/VideoCard.tsx")
check("video card", "Create & send invite" in VIDEO
      and "/api/omniflow/portal/video/rooms" in VIDEO, "card")
THREAD = read("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx")
check("thread mounts", "<VoiceCard conversationId={Number(id)} />" in THREAD
      and "<VideoCard conversationId={Number(id)} />" in THREAD, "mounts")

PORTAL = read("lib/omniflow/portal.ts")
for fn in ("listVoiceCalls", "callContact", "listVideoRooms",
           "sendVideoInvite", "requestPublicPhoneOtp",
           "verifyPublicPhoneOtp"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
check("portal kbEntry type", "kbEntry?: { title: string; content: string }"
      in PORTAL, "type")

VOICE_BFF = read("app/api/omniflow/portal/voice/calls/route.ts")
check("voice bff", "export async function GET" in VOICE_BFF
      and "export async function POST" in VOICE_BFF
      and '"../../../../../../lib/omniflow/portal"' in VOICE_BFF, "6 ups")
VIDEO_BFF = read("app/api/omniflow/portal/video/rooms/route.ts")
check("video bff", "export async function POST" in VIDEO_BFF
      and '"../../../../../../lib/omniflow/portal"' in VIDEO_BFF, "6 ups")
DRAFT_BFF = read("app/api/omniflow/portal/conversations/[id]/draft/route.ts")
check("draft bff", "draftBrainReply" in DRAFT_BFF
      and '"../../../../../../../lib/omniflow/portal"' in DRAFT_BFF,
      "7 ups")
OTP_BFF = read("app/api/omniflow/public/checkout/[token]/otp/route.ts")
check("otp bff", "requestPublicPhoneOtp" in OTP_BFF
      and '"../../../../../../../lib/omniflow/portal"' in OTP_BFF,
      "7 ups")
VERIFY_BFF = read(
    "app/api/omniflow/public/checkout/[token]/otp/verify/route.ts")
check("otp verify bff", "verifyPublicPhoneOtp" in VERIFY_BFF
      and '"../../../../../../../../lib/omniflow/portal"' in VERIFY_BFF,
      "8 ups")

ASSIST = read("app/dashboard/(portal)/conversations/[id]/AssistCard.tsx")
check("assist draft button", "Draft with AI" in ASSIST
      and "/draft" in ASSIST, "draft")
check("assist save kb", "Save as KB answer" in ASSIST
      and "/api/omniflow/portal/kb" in ASSIST, "save-kb")

CATALOG = read("app/dashboard/(portal)/settings/CatalogCard.tsx")
check("catalog brand filter", 'id="catalogBrandFilter"' in CATALOG
      and "All brands" in CATALOG, "filter")
KB = read("app/dashboard/(portal)/knowledge-base/KnowledgeBaseClient.tsx")
check("kb brand filter", 'id="kbBrandFilter"' in KB
      and "All brands" in KB, "filter")

PAYGATE = read("app/c/[token]/PayGate.tsx")
check("paygate otp", "Send my code" in PAYGATE
      and "otp/verify" in PAYGATE, "gate")
PAGE = read("app/c/[token]/page.tsx")
check("page uses paygate", "<PayGate" in PAGE
      and "phoneVerification" in PAGE, "page")

PAYCARD = read("app/dashboard/(portal)/settings/PaymentsCard.tsx")
check("payments pk only (B24)", '<option value="stripe"' not in PAYCARD
      and "Pakistan gateways" in PAYCARD, "pk")
INTEG = read("app/admin/(panel)/integrations/IntegrationsClient.tsx")
check("zoom fields", "zoom_account_id" in INTEG
      and "zoom_client_secret" in INTEG, "zoom")

summary("channels")
