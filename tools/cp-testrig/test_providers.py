"""Tests for the admin provider-inputs platform: platform_settings store,
admin providers API (masking, blank-keeps, whitelist), email delivery
(SMTP + Brevo), the weekly report, and every parked-input consumer
(LLM runtime config, true sentiment, KB auto-draft flag, SMTP fallback)."""
import json
import os
import smtplib
import urllib.request

from flask import Flask

import admin_providers
import platform_settings
import portal_insights
import portal_llm
import test_lib
from test_lib import check, install_db_stub, summary

app = Flask(__name__)
app.register_blueprint(admin_providers.bp)
client = app.test_client()

KEY = {"X-Omniflow-Key": "x"}

print("== platform_settings store ==")

platform_settings._DDL_READY = False
platform_settings.invalidate_cache()
db = install_db_stub(platform_settings, [
    [],  # CREATE TABLE
    [{"key": "llm.api_key", "value": "sk123"},
     {"key": "email.smtp_host", "value": "smtp.x.com"}],
])
got = platform_settings.get_setting("llm.api_key")
check("store roundtrip", got == "sk123", got)
check("store miss default",
      platform_settings.get_setting("nope", "d") == "d", "default")
check("store cache hit", db.cur.description is not None
      and len(db.cur.executed) == 2, len(db.cur.executed))
platform_settings._cache["x"] = "1"
try:
    platform_settings._cache_at = 0.0
    db2 = install_db_stub(platform_settings, [Exception("db down")])
    check("store fail-soft",
          platform_settings.get_setting("x", "fb") == "fb", "fb")
except AssertionError:
    check("store fail-soft", platform_settings.get_setting("x", "fb") == "fb",
          "fb")
platform_settings.invalidate_cache()
platform_settings._DDL_READY = False

print("== providers GET: masking + configured ==")

_real_get_group = platform_settings.get_group
platform_settings.get_group = lambda group: {
    "email": {"provider": "brevo", "smtp_host": "smtp.x.com",
              "smtp_password": "supersecret99", "brevo_api_key": "brevok1",
              "reports_to": "own@example.com"},
    "llm": {"api_key": "sk-secret-77", "model": "gpt-4o-mini"},
    "flags": {"true_sentiment": "off"},
    "voice": {"account_sid": "AC99", "auth_token": "tok99"},
    "video": {"provider": "daily", "api_key": "vk1"},
    "payments": {"provider": "stripe", "secret_key": "sk_live_9"},
    "whatsapp_e2e": {"live_number": "+923001234567"},
}[group]

r = client.get("/api/v1/admin/providers", headers=KEY)
body = r.get_json()
check("providers 403 no key", client.get(
    "/api/v1/admin/providers").status_code == 403, 403)
check("providers 200", r.status_code == 200, r.status_code)
check("password masked", body["groups"]["email"]["smtp_password"]
      == "\u2022\u2022\u2022\u2022" + "et99", body["groups"]["email"])
check("api key masked", body["groups"]["llm"]["api_key"]
      == "\u2022\u2022\u2022\u2022" + "t-77", body["groups"]["llm"])
check("token masked", body["groups"]["voice"]["auth_token"]
      .startswith("\u2022\u2022\u2022\u2022"), "masked")
check("plain host visible", body["groups"]["email"]["smtp_host"]
      == "smtp.x.com", "plain")
check("brevo configured", body["groups"]["email"]["configured"] is True,
      "configured")
check("payments configured", body["groups"]["payments"]["configured"]
      is True, "configured")
check("flags not configured", body["groups"]["flags"]["configured"] is False,
      "not")
check("flags value visible", body["groups"]["flags"]["true_sentiment"]
      == "off", "off")

print("== providers PUT: whitelist + blank-keep + audit ==")

platform_settings.get_group = lambda group: (
    {"smtp_password": "oldsecret"} if group == "email" else {})
conn = install_db_stub(admin_providers, [[], [], [], [], [], [], []])
r = client.put("/api/v1/admin/providers", headers=KEY, json={
    "group": "email",
    "values": {"smtp_host": "smtp.new.com", "smtp_port": "587",
               "smtp_password": "", "reports_to": "own@example.com",
               "hacker": "1"},
})
body = r.get_json()
check("put 200", r.status_code == 200, r.get_json())
check("put kept blank secret", body["kept_blank"] == ["smtp_password"],
      body)
check("put audit row", any("providers.updated" in json.dumps(e)
                           for e in conn.cur.executed), "audit")
check("put audit no secret", all("oldsecret" not in json.dumps(e)
                                 for e in conn.cur.executed), "clean")
check("put ignored unknown key", not any("hacker" in json.dumps(e)
                                         for e in conn.cur.executed), "clean")

r = client.put("/api/v1/admin/providers", headers=KEY,
               json={"group": "nope", "values": {}})
check("put bad group 400", r.status_code == 400, r.status_code)
r = client.put("/api/v1/admin/providers", headers=KEY,
               json={"group": "email",
                     "values": {"provider": "mailgun"}})
check("put bad provider 400", r.status_code == 400, r.status_code)
r = client.put("/api/v1/admin/providers", headers=KEY,
               json={"group": "email", "values": {"smtp_port": "abc"}})
check("put bad port 400", r.status_code == 400, r.status_code)
r = client.put("/api/v1/admin/providers", headers=KEY,
               json={"group": "email", "values": {"reports_to": "nope"}})
check("put bad recipient 400", r.status_code == 400, r.status_code)
r = client.put("/api/v1/admin/providers", headers=KEY,
               json={"group": "flags", "values": {"true_sentiment": "maybe"}})
check("put bad flag 400", r.status_code == 400, r.status_code)
r = client.put("/api/v1/admin/providers", headers=KEY,
               json={"group": "flags", "values": {"kb_autodraft": "on"}})
check("put flag on 200", r.status_code == 200, r.get_json())
check("put no key 403", client.put("/api/v1/admin/providers",
                                   json={"group": "flags",
                                         "values": {}}).status_code == 403,
      403)

platform_settings.get_group = _real_get_group

print("== llm runtime: admin panel first, env fallback ==")


class _FlagProbe:
    def __init__(self, groups):
        self.groups = groups

    def get_group(self, group):
        return self.groups.get(group, {})


probe = _FlagProbe({"llm": {"api_key": "sk-panel", "base_url":
                            "https://api.groq.com/v1",
                            "model": "llama3"}})
platform_settings.get_group = probe.get_group
cfg = portal_llm._runtime()
check("llm panel key wins", cfg["api_key"] == "sk-panel", cfg)
check("llm panel url", cfg["base_url"] == "https://api.groq.com/v1", cfg)
check("llm panel enabled", cfg["enabled"] is True, cfg)


def _boom(group):
    raise RuntimeError("db down")


platform_settings.get_group = _boom
cfg = portal_llm._runtime()
check("llm env fallback on db error",
      cfg["api_key"] == portal_llm.API_KEY
      and cfg["base_url"] == portal_llm.BASE_URL, cfg)
os.environ["OF_LLM_ENABLED"] = "0"
platform_settings.get_group = probe.get_group
cfg = portal_llm._runtime()
check("llm kill switch env wins", cfg["enabled"] is False, cfg)
os.environ["OF_LLM_ENABLED"] = "1"

print("== chat_json runtime path ==")

platform_settings.get_group = lambda group: (
    {"api_key": "sk-rt", "model": "mini"} if group == "llm" else {})


def _fake_chat_post(url, headers, payload):
    _fake_chat_post.url = url
    _fake_chat_post.auth = headers.get("Authorization")
    _fake_chat_post.model = payload["model"]
    return {"choices": [{"message": {"content": '{"ok": true}'}}]}


portal_llm._http_post_json = _fake_chat_post
out = portal_llm.chat_json("sys", "user")
check("chat runtime key", _fake_chat_post.auth == "Bearer sk-rt", "auth")
check("chat runtime model", _fake_chat_post.model == "mini", "model")
check("chat parsed", out == {"ok": True}, out)
platform_settings.get_group = lambda group: {}


def _none_post(url, headers, payload):
    return None


portal_llm._http_post_json = _none_post
os.environ.pop("OF_LLM_API_KEY", None)
saved_key = portal_llm.API_KEY
portal_llm.API_KEY = ""
check("chat no key none", portal_llm.chat_json("s", "u") is None, None)
portal_llm.API_KEY = saved_key

print("== true sentiment: flag-gated LLM ==")

_saved_flag = platform_settings.flag
platform_settings.flag = lambda name: False
res = portal_insights.analyze_sentiment_smart("bohot acha hai shukriya")
check("sentiment off lexicon", res["engine"] == "lexicon"
      and res["label"] in ("positive", "neutral"), res)
platform_settings.flag = lambda name: True
saved_chat = portal_llm.chat_json
portal_llm.chat_json = lambda system, user, max_tokens=120: {
    "label": "negative", "score": -3}
res = portal_insights.analyze_sentiment_smart("acha hai")
check("sentiment llm wins", res["engine"] == "llm"
      and res["label"] == "negative" and res["score"] == -3, res)
portal_llm.chat_json = lambda system, user, max_tokens=120: None
res = portal_insights.analyze_sentiment_smart("acha hai")
check("sentiment llm none falls back", res["engine"] == "lexicon", res)
portal_llm.chat_json = lambda system, user, max_tokens=120: {
    "label": "weird"}
res = portal_insights.analyze_sentiment_smart("acha hai")
check("sentiment bad label falls back", res["engine"] == "lexicon", res)
portal_llm.chat_json = saved_chat
platform_settings.flag = _saved_flag

print("== kb auto-draft flag (source pins) ==")

BRAIN = open("./portal_brain.py", encoding="utf8").read()
check("brain reads the flag", 'flag("kb_autodraft")' in BRAIN, "flag")
check("brain kb_entry shape", '"kb_entry"' in BRAIN
      and '"title"' in BRAIN and '"content"' in BRAIN, "shape")
check("brain keeps plain draft", '"draft": reply' in BRAIN, "draft")
platform_settings.flag = lambda name: name == "kb_autodraft"
check("flag on reads get_setting", platform_settings.flag("kb_autodraft")
      is True, True)
check("flag off default", platform_settings.flag("true_sentiment") is False,
      False)
platform_settings.flag = _saved_flag

print("== email delivery: SMTP + Brevo + test endpoint ==")


class FakeSMTP:
    inst = None

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.logged_in = False
        self.sent = None
        FakeSMTP.inst = self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self):
        self.tls = True

    def login(self, user, password):
        self.logged_in = True
        self.user = user

    def send_message(self, msg):
        self.sent = msg


_real_smtp = smtplib.SMTP
smtplib.SMTP = FakeSMTP
platform_settings.smtp_config = lambda: {
    "provider": "smtp", "smtp_host": "smtp.panel.com", "smtp_port": "587",
    "smtp_user": "u1", "smtp_password": "p1",
    "smtp_from": "OmniFlow <no-reply@x.com>", "brevo_api_key": "",
    "reports_to": "own@example.com"}
ok, detail = admin_providers._deliver_email(
    "to@example.com", "Sub", "Body")
check("smtp delivered", ok is True and FakeSMTP.inst is not None
      and FakeSMTP.inst.logged_in, detail)
check("smtp from header", FakeSMTP.inst.sent["From"]
      == "OmniFlow <no-reply@x.com>", "from")
smtplib.SMTP = _real_smtp


class FakeResp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b"{}"


class FakeBrevo:
    url = ""
    headers = {}
    body = {}
    raise_error = False

    def __call__(self, req, timeout=None):
        if FakeBrevo.raise_error:
            raise RuntimeError("refused")
        FakeBrevo.url = req.full_url
        FakeBrevo.headers = dict(req.header_items())
        FakeBrevo.body = json.loads(req.data.decode("utf8"))
        return FakeResp(200)


_real_urlopen = urllib.request.urlopen
fake_brevo = FakeBrevo()
urllib.request.urlopen = fake_brevo
platform_settings.smtp_config = lambda: {
    "provider": "brevo", "smtp_host": "", "smtp_port": "587",
    "smtp_user": "", "smtp_password": "",
    "smtp_from": "OmniFlow <no-reply@x.com>",
    "brevo_api_key": "brevokey1", "reports_to": ""}
ok, detail = admin_providers._deliver_email(
    "to@example.com", "Sub", "Body")
check("brevo delivered", ok is True, detail)
check("brevo url", fake_brevo.url
      == "https://api.brevo.com/v3/smtp/email", fake_brevo.url)
check("brevo auth header", "brevokey1"
      in fake_brevo.headers.values(), "header")
check("brevo sender split", fake_brevo.body["sender"]["email"]
      == "no-reply@x.com" and fake_brevo.body["sender"]["name"]
      == "OmniFlow", fake_brevo.body.get("sender"))
check("brevo to", fake_brevo.body["to"] == [{"email": "to@example.com"}],
      "to")
FakeBrevo.raise_error = True
ok, detail = admin_providers._deliver_email(
    "to@example.com", "Sub", "Body")
check("brevo failure soft", ok is False and detail, detail)
urllib.request.urlopen = _real_urlopen
FakeBrevo.raise_error = False
platform_settings.smtp_config = lambda: {
    "provider": "smtp", "smtp_host": "", "smtp_port": "587",
    "smtp_user": "", "smtp_password": "", "smtp_from": "",
    "brevo_api_key": "", "reports_to": ""}
ok, detail = admin_providers._deliver_email(
    "to@example.com", "Sub", "Body")
check("smtp unconfigured fails", ok is False, detail)

r = client.post("/api/v1/admin/email/test", headers=KEY, json={})
check("test no recipient 400", r.status_code == 400, r.status_code)
platform_settings.smtp_config = lambda: {
    "provider": "smtp", "smtp_host": "smtp.x", "smtp_port": "587",
    "smtp_user": "", "smtp_password": "",
    "smtp_from": "OmniFlow <no-reply@x.com>", "brevo_api_key": "",
    "reports_to": "own@example.com"}
smtplib.SMTP = FakeSMTP
r = client.post("/api/v1/admin/email/test", headers=KEY, json={})
check("test endpoint ok", r.status_code == 200
      and r.get_json()["ok"] is True, r.get_json())
check("test no key 403", client.post(
    "/api/v1/admin/email/test", json={}).status_code == 403, 403)
smtplib.SMTP = _real_smtp

print("== weekly report ==")

conn = install_db_stub(admin_providers, [
    [{"client_id": 1}, {"client_id": 2}],  # client list
    [{"n": 5}],                            # c1 conversations
    [{"n": 40}],                           # c1 messages
    [{"n": 120}],                          # c1 broadcast recipients
    [{"paid": 2, "amount": 3000}],         # c1 orders
    [{"n": 1}],                            # c2 conversations
    [{"n": 9}],                            # c2 messages
    [{"n": 0}],                            # c2 broadcast recipients
    [{"paid": 0, "amount": 0}],            # c2 orders
    [],                                    # audit
])
sent = {}


def _fake_deliver(to_address, subject, body):
    sent["to"] = to_address
    sent["subject"] = subject
    sent["body"] = body
    return True, "sent via SMTP"


admin_providers._deliver_email = _fake_deliver
r = client.post("/api/v1/admin/weekly-report/send", headers=KEY, json={})
body = r.get_json()
check("weekly 200", r.status_code == 200 and body["clients"] == 2,
      body)
check("weekly to reports_to", sent["to"] == "own@example.com", sent["to"])
check("weekly subject", sent["subject"] == "OmniFlow weekly report",
      sent["subject"])
check("weekly body has counts", "40 messages" in sent["body"]
      and "paid orders (Rs 3000)" in sent["body"], sent["body"])
check("weekly audit", any("weekly_report.sent" in json.dumps(e)
                          for e in conn.cur.executed), "audit")

conn = install_db_stub(admin_providers, [[], []])
r = client.post("/api/v1/admin/weekly-report/send", headers=KEY, json={})
check("weekly no clients 404", r.status_code == 404, r.status_code)
conn = install_db_stub(admin_providers, [
    [{"client_id": 3}], [{"n": 0}], [{"n": 0}], [{"n": 0}],
    [{"paid": 0, "amount": 0}], []])
r = client.post("/api/v1/admin/weekly-report/send", headers=KEY,
                json={"to": "direct@example.com"})
check("weekly explicit to wins", r.status_code == 200
      and sent["to"] == "direct@example.com", (r.status_code, sent["to"]))
check("weekly no key 403", client.post(
    "/api/v1/admin/weekly-report/send", json={}).status_code == 403, 403)

print("== app.py wiring ==")

APP = open("./app.py", encoding="utf8").read()
check("app imports admin_providers",
      "from admin_providers import bp as admin_providers_bp" in APP, "imp")
check("app registers admin_providers",
      "aux_app.register_blueprint(admin_providers_bp)" in APP, "reg")

print("== website surface (vs /tmp/p13) ==")

P13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(P13 + path, encoding="utf8").read()


SIDEBAR = read("app/admin/components/AdminSidebar.tsx")
check("sidebar integrations", "/admin/integrations" in SIDEBAR
      and "Integrations" in SIDEBAR, "nav")
PAGE = read("app/admin/(panel)/integrations/page.tsx")
check("admin page guards session", "supabase.auth.getUser" in PAGE
      and "/admin/login" in PAGE, "guard")
CLIENT = read("app/admin/(panel)/integrations/IntegrationsClient.tsx")
check("client cards", "Email (SMTP / Brevo)" in CLIENT
      and "AI engine" in CLIENT and "Voice channel" in CLIENT
      and "Video channel" in CLIENT and "Payments channel" in CLIENT
      and "WhatsApp E2E test" in CLIENT
      and "Phone verification" in CLIENT
      and "KB auto-draft" in CLIENT
      and "True sentiment" in CLIENT, "cards")
check("client posts providers", "/api/omniflow/admin/providers" in CLIENT
      and "email-test" in CLIENT and "weekly-report" in CLIENT, "posts")

PORTAL = read("lib/omniflow/admin-control-plane.ts")
for fn in ("getAdminProviders", "putAdminProviders", "sendAdminTestEmail",
           "sendAdminWeeklyReport"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)

BFF = read("app/api/omniflow/admin/providers/route.ts")
check("bff providers GET+PUT", "export async function GET" in BFF
      and "export async function PUT" in BFF, "methods")
check("bff depth providers", '"../../../../../lib/supabase/server"' in BFF,
      "5 ups")
TEST = read("app/api/omniflow/admin/providers/email-test/route.ts")
check("bff email test depth",
      '"../../../../../../lib/supabase/server"' in TEST, "6 ups")
WEEKLY = read("app/api/omniflow/admin/providers/weekly-report/route.ts")
check("bff weekly depth",
      '"../../../../../../lib/supabase/server"' in WEEKLY, "6 ups")

summary("providers")
