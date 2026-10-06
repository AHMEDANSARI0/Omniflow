"""§243 email channel (portal_email_channel + connector / inbox wiring).

Units: settings validation (hosts, ports, password keep, enable only after a
passing test, control characters), parsing real MIME (plain / html-only /
attachments / quoted history / Outlook block / signature / encoded subject),
robot and loop guards, the reply builder (Re: once, threading headers,
Auto-Submitted only for automation, header injection), refusals, TLS-only
connections (993 / STARTTLS, 465 / STARTTLS, no plain text), the public-host
guard, the tick throttle, source pins (brain answers customers only, tick +
inbox kick, CP-dispatched channel filter, away replies, identity link).
HTTP guards (401 / 503 / 403 API key / 403 non-editor / 400 / 503 without
internals). Then the real thing on pgserver with fake IMAP / SMTP servers:
sealed password, test connection, old mail never imported, new mail through
the shared ingest (conversation, identity, thread, brain called once),
read-only mailbox, Message-ID dedupe, replies in the customer's thread,
refusals, retries, recipient refused, SMTP down while import continues,
laptop bridges never see email commands or away replies, the away reply
sent by email, recent / busy guards, UIDVALIDITY reset, rate limit keeps
the cursor, and a foreign workspace next to it all.
"""
import imaplib
import json
import os
import smtplib
import sys
import tempfile
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
os.environ["OF_SECRETS_KEY"] = "email-channel-test-key-0123456789abcdef"
os.environ["OF_PROACTIVE"] = "0"
for name in ("OF_EMAIL_CHANNEL", "OF_EMAIL_POLL_SECONDS", "OF_EMAIL_MAX_PER_POLL",
             "OF_EMAIL_MAX_SEND", "OF_EMAIL_MAX_BYTES", "OF_EMAIL_DEFAULT_SUBJECT",
             "OF_NOTIFY_ROLES", "OF_SECRETS_KEY_OLD"):
    os.environ.pop(name, None)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_email_channel as E  # noqa: E402
import portal_channels  # noqa: E402
import connector_api  # noqa: E402
from portal_auth import PortalAuthUnavailable  # noqa: E402

HERE = os.getcwd()


def src(name):
    return open(os.path.join(HERE, name), encoding="utf8").read()


def mail(sender="Ali Khan <ali@customer.pk>", subject="Order #12 late", body="Mera order kahan hai?",
         msgid="<m1@customer.pk>", html=None, headers=None, attach=None, reply_to=None):
    m = EmailMessage()
    m["From"] = sender
    m["To"] = "shop@store.pk"
    if subject is not None:
        m["Subject"] = subject
    if msgid:
        m["Message-ID"] = msgid
    if reply_to:
        m["In-Reply-To"] = reply_to
        m["References"] = "<root@customer.pk> " + reply_to
    for key, value in (headers or {}).items():
        m[key] = value
    m.set_content(body)
    if html is not None:
        m.add_alternative(html, subtype="html")
    if attach:
        m.add_attachment(b"%PDF-1.4", maintype="application", subtype="pdf", filename=attach)
    return m.as_bytes()


BASE = {"address": "Shop@Store.pk", "display_name": "Store PK", "password": "app-pass-1",
        "imap_host": "imap.store.pk", "imap_port": 993, "smtp_host": "smtp.store.pk", "smtp_port": 465}

print("== settings validation ==")
clean, err = E.clean_settings(dict(BASE), None)
check("valid form: lower-cased address, username defaults to it, ports kept",
      err is None and clean["address"] == "shop@store.pk" and clean["username"] == "shop@store.pk"
      and clean["imap_port"] == 993 and clean["smtp_port"] == 465 and clean["enabled"] is False
      and clean["credentials_changed"] is True, (clean, err))
saved = dict(clean, verified_at="2026-10-06")
clean, err = E.clean_settings(dict(BASE, password="", enabled=True), saved)
check("blank password keeps the saved one; enable allowed when verified and unchanged",
      err is None and clean["password"] == "app-pass-1" and clean["enabled"] is True
      and clean["credentials_changed"] is False, (clean, err))
clean, err = E.clean_settings(dict(BASE, imap_host="imap2.store.pk", enabled=True), saved)
check("changed credentials cannot stay on (test again first)", clean is None and "Test connection" in err, err)
clean, err = E.clean_settings(dict(BASE, enabled=True), None)
check("enable before any test -> refused", clean is None and "Test connection" in err, err)
for label, change, needle in (
        ("missing address", {"address": "nope"}, "email address"),
        ("missing password", {"password": ""}, "password"),
        ("password with a newline", {"password": "a\nb"}, "not valid"),
        ("password not text", {"password": 5}, "must be text"),
        ("host with a path", {"imap_host": "imap.store.pk/x"}, "IMAP server host"),
        ("single-label host", {"smtp_host": "localhost"}, "SMTP server host"),
        ("port out of range", {"imap_port": 70000}, "IMAP port"),
        ("bool port", {"smtp_port": True}, "SMTP port"),
        ("non-ASCII digits port", {"imap_port": "\u0669\u0669\u0663"}, "IMAP port"),
        ("enabled not a bool", {"enabled": "yes"}, "true or false")):
    clean, err = E.clean_settings(dict(BASE, **change), None)
    check("refused: " + label, clean is None and needle in (err or ""), err)
clean, err = E.clean_settings(dict(BASE, imap_port=" 143 ", smtp_port="587",
                                   display_name="Store\r\nBcc: x@evil.pk", username=" Box\tUser "), None)
check("string ports accepted; display name / username lose control characters",
      err is None and clean["imap_port"] == 143 and clean["smtp_port"] == 587
      and "\n" not in clean["display_name"] and "\r" not in clean["display_name"]
      and clean["username"] == "Box User", (clean, err))
check("non-object payload refused", E.clean_settings("x", None)[0] is None)
pub = E.public_settings({"password": "secret", "address": "a@b.pk", "enabled": True, "verified_at": None})
check("public settings never carry the password", "password" not in pub and pub["password_set"] is True
      and pub["verified"] is False and pub["imap_port"] == 993 and pub["smtp_port"] == 465)

print("== parsing ==")
p = E.parse_email(mail(body="Mera order kahan hai?\n\nOn Mon, 5 Oct 2026 at 10:00, Store <shop@store.pk>\n"
                            "wrote:\n> purana jawab\n", attach="invoice.pdf"), "shop@store.pk")
check("new thread: subject line + new text + attachment name; quoted history cut",
      p["skip"] == "" and p["sender"] == "ali@customer.pk" and p["name"] == "Ali Khan"
      and p["body"] == "Subject: Order #12 late\n\nMera order kahan hai?\n[Attachment: invoice.pdf]"
      and p["message_id"] == "<m1@customer.pk>", p)
p = E.parse_email(mail(subject="Re: Order #12 late", reply_to="<out1@store.pk>",
                       body="Theek hai shukriya\n-- \nAli\n0300-1234567"), "shop@store.pk")
check("reply: no subject line, signature cut, threading ids kept",
      p["body"] == "Theek hai shukriya" and p["in_reply_to"] == "<out1@store.pk>"
      and p["refs"] == ["<root@customer.pk>", "<out1@store.pk>"], p)
p = E.parse_email(mail(subject="Re: hi", body="Naya sawal\nFrom: Store PK\nSent: Monday\nold text"), "")
check("Outlook From / Sent block cut; Re: subject not repeated", p["body"] == "Naya sawal", p)
p = E.parse_email(mail(subject="Re: x", body="Yes please\n> old line\n>> older\nThanks"), "")
check("'>' quote lines dropped, the rest kept", p["body"] == "Yes please\nThanks", p)
p = E.parse_email(mail(subject="Re: x", body="a\n-----Original Message-----\nold"), "")
check("Original Message separator cut", p["body"] == "a", p)
p = E.parse_email(mail(subject="Re: x", body="On Monday Ali wrote: about the order"), "")
check("a sentence starting with 'On' is kept", p["body"] == "On Monday Ali wrote: about the order", p)
html_only = EmailMessage()
html_only["From"] = "sara@customer.pk"
html_only["Subject"] = "=?utf-8?b?2KLYsdqI2LE=?="
html_only.set_content("<html><head><style>p{}</style></head><body><p>Price &amp; size?</p>"
                      "<script>x()</script><div>Thanks</div></body></html>", subtype="html")
p = E.parse_email(html_only.as_bytes(), "")
check("html-only email -> plain text (no script / style), encoded subject decoded",
      p["body"] == "Subject: \u0622\u0631\u0688\u0631\n\nPrice & size?\nThanks", p)
latin = (b"From: x@customer.pk\r\nSubject: Re: a\r\nContent-Type: text/plain; charset=latin-1\r\n"
         b"Content-Transfer-Encoding: 8bit\r\n\r\ncaf\xe9\r\n")
check("legacy charset decoded", E.parse_email(latin, "")["body"] == "caf\u00e9")
check("empty email -> subject or a placeholder",
      E.parse_email(mail(subject="Re: Hello", body=""), "")["body"] == "Re: Hello"
      and E.parse_email(mail(subject=None, body=""), "")["body"] == "(empty email)")
check("long email capped", len(E.parse_email(mail(body="x" * 9000), "")["body"]) == E.MAX_TEXT)
for label, kwargs in (
        ("Auto-Submitted auto-replied", {"headers": {"Auto-Submitted": "auto-replied"}}),
        ("Precedence bulk", {"headers": {"Precedence": "bulk"}}),
        ("mailing list (List-Id)", {"headers": {"List-Id": "<news.store.pk>"}}),
        ("List-Unsubscribe", {"headers": {"List-Unsubscribe": "<mailto:u@x.pk>"}}),
        ("X-Autoreply", {"headers": {"X-Autoreply": "yes"}}),
        ("bounce (Return-Path <>)", {"headers": {"Return-Path": "<>"}}),
        ("mailer-daemon", {"sender": "MAILER-DAEMON@mx.pk"}),
        ("no-reply sender", {"sender": "No-Reply <no-reply@bank.pk>"}),
        ("our own address", {"sender": "Store <SHOP@store.pk>"})):
    check("skipped: " + label, E.parse_email(mail(**kwargs), "shop@store.pk")["skip"] == "automated")
check("Auto-Submitted: no is a person", E.parse_email(
    mail(headers={"Auto-Submitted": "no"}), "shop@store.pk")["skip"] == "")
check("no usable sender -> skipped", E.parse_email(mail(sender="not an address"), "")["skip"] == "no_sender")

print("== replies ==")
acc = {"address": "shop@store.pk", "display_name": "Store PK"}
thread = {"subject": "Re: RE: Order #12 late", "message_id": "<m1@customer.pk>", "refs": "<root@customer.pk>"}
r = E.build_reply(acc, "ali@customer.pk", "Ji, check karte hain.", thread, True)
check("reply in the customer's thread: Re: once, In-Reply-To, References, own Message-ID",
      r["Subject"] == "Re: Order #12 late" and r["In-Reply-To"] == "<m1@customer.pk>"
      and r["References"] == "<root@customer.pk> <m1@customer.pk>"
      and r["Message-ID"].endswith("@store.pk>") and r["From"] == "Store PK <shop@store.pk>"
      and r["To"] == "ali@customer.pk", str(r))
check("automated reply marked Auto-Submitted (RFC 3834)", r["Auto-Submitted"] == "auto-replied")
r = E.build_reply(acc, "ali@customer.pk", "Hello", None, False)
check("human reply: no Auto-Submitted; no thread -> default subject, no In-Reply-To",
      r["Auto-Submitted"] is None and r["Subject"] == "Message from Store PK" and r["In-Reply-To"] is None)
r = E.build_reply({"address": "shop@store.pk", "display_name": "Evil\r\nBcc: all@x.pk"}, "a@b.pk", "x", None, False)
parsed = BytesParser(policy=policy.default).parsebytes(r.as_bytes())
check("header injection in the display name is neutralised", parsed["Bcc"] is None
      and "\n" not in str(parsed["From"]), r.as_string()[:200])
long_refs = " ".join("<r%d@x.pk>" % i for i in range(20))
r = E.build_reply(acc, "a@b.pk", "x", {"subject": "s", "message_id": "<last@x.pk>", "refs": long_refs}, False)
check("References capped at 10 ids, parent last", len(r["References"].split()) == 10
      and r["References"].split()[-1] == "<last@x.pk>")


def item(action="send_message", contact="em:ali@customer.pk", body="hi"):
    return {"kind": "command", "id": 1, "action": action,
            "payload": {"external_user_id": contact, "body": body}}


check("refusals: media / templates, a non-email contact, a bad address, an empty body",
      E.refusal(item("send_media")).startswith("Email replies support text")
      and E.refusal(item("send_template")).startswith("Email replies support text")
      and "no valid email" in E.refusal(item(contact="923001234567"))
      and "no valid email" in E.refusal(item(contact="em:nope"))
      and "empty" in E.refusal(item(body="  "))
      and E.refusal(item()) == "" and E.refusal(item("send_interactive")) == "")

print("== routing + wiring ==")
check("channel_for_contact: em: -> email; others unchanged",
      [portal_channels.channel_for_contact(c) for c in ("em:a@b.pk", "EM:A@B.PK", "tg:1", "ig:1", "fb:1", "9230")]
      == ["email", "email", "telegram", "instagram", "messenger", "whatsapp"])
check("email is an ingest channel and Control-Plane dispatched",
      "email" in connector_api.ALLOWED_CHANNELS and connector_api.CP_DISPATCHED_CHANNELS == ("email", "sms"))
CONN = src("connector_api.py")
check("unfiltered bridge poll excludes Control-Plane channels",
      'cmd_sql += " AND channel <> ALL(%s)"' in CONN and "cmd_params.append(list(CP_DISPATCHED_CHANNELS))" in CONN)
check("laptop away-reply poll excludes em: contacts", "\" AND contact_id NOT LIKE 'em:%%'\"" in CONN)
check("brain answers customers only (never recorded outgoing messages)",
      'if claimed_by is None and item["direction"] == "in":\n' in CONN
      and CONN.index('if claimed_by is None and item["direction"] == "in":') < CONN.index("portal_brain.maybe_answer("))
check("email senders link as email identities", '"em:": "email", "sms:": "phone"}' in CONN
      and '"instagram", "messenger", "email", "sms") else None' in CONN)
check("connector tick kicks the email channel in its own guard",
      "                    import portal_email_channel\n" in CONN
      and 'portal_email_channel.kick(tenant["client_id"])' in CONN)
CONV = src("portal_conversations.py")
check("inbox list kicks the email channel; filter knows telegram + email",
      'portal_email_channel.kick(principal.get("client_id"))' in CONV
      and 'INBOX_CHANNELS = ("whatsapp", "website", "instagram", "messenger", "telegram", "email", "sms")' in CONV
      and CONV.count("if channel_filter in INBOX_CHANNELS:") == 3)
check("app registers the blueprint", "aux_app.register_blueprint(portal_email_channel_bp)" in src("app.py"))
MOD = src("portal_email_channel.py")
check("mailbox opened read-only and fetched with BODY.PEEK; never STORE / EXPUNGE / DELETE",
      'box.select("INBOX", readonly=True)' in MOD and "BODY.PEEK[]" in MOD
      and "STORE" not in MOD and "expunge" not in MOD.lower() and ".delete(" not in MOD)
check("every table read is tenant-scoped (queue rows: portal_cp_outbox)", MOD.count("WHERE client_id = %s") == 11
      and "portal_cp_outbox.pending(cur, client_id, CHANNEL, PREFIX, MAX_SEND_PER_RUN)" in MOD, MOD.count("WHERE client_id = %s"))
check("password sealed on write, opened on read", "portal_vault.seal(clean[\"password\"])" in MOD
      and 'VAULT_FIELDS = ("password",)' in MOD)

print("== connections (TLS only) ==")


class FakeIMAP:
    log = []
    box = {"validity": 11, "mails": {}}
    password = "app-pass-1"
    fail_connect = False

    def __init__(self, host, port, ssl_context=None, timeout=None):
        if FakeIMAP.fail_connect:
            raise ConnectionRefusedError("no")
        self.kind = "ssl" if ssl_context is not None else "plain"
        FakeIMAP.log.append(("open", self.kind, host, port, timeout))

    def starttls(self, ssl_context=None):
        FakeIMAP.log.append(("starttls",))

    def login(self, user, password):
        FakeIMAP.log.append(("login", user))
        if password != FakeIMAP.password:
            raise imaplib.IMAP4.error("AUTHENTICATIONFAILED " + password)

    def status(self, mailbox, what):
        uids = sorted(FakeIMAP.box["mails"])
        nxt = (uids[-1] + 1) if uids else 1
        return "OK", [b"INBOX (UIDNEXT %d UIDVALIDITY %d)" % (nxt, FakeIMAP.box["validity"])]

    def select(self, mailbox, readonly=False):
        FakeIMAP.log.append(("select", mailbox, readonly))
        return "OK", [b"1"]

    def uid(self, command, *args):
        FakeIMAP.log.append(("uid", command) + args)
        uids = sorted(FakeIMAP.box["mails"])
        if command == "SEARCH":
            low = int(args[1].split()[1].split(":")[0])
            hits = [u for u in uids if u >= low] or uids[-1:]  # RFC: "n:*" returns the last
            return "OK", [b" ".join(str(u).encode() for u in hits)]
        if command == "FETCH":
            raw = FakeIMAP.box["mails"][int(args[0])]
            limit = int(args[1].split("<0.")[1].split(">")[0])
            return "OK", [(b"1 (UID %s RFC822.SIZE %d BODY[]<0> {%d}" % (args[0].encode(), len(raw),
                                                                         min(len(raw), limit)),
                           raw[:limit]), b")"]
        raise AssertionError("unexpected IMAP command " + command)

    def logout(self):
        FakeIMAP.log.append(("logout",))


class FakeSMTP:
    log = []
    sent = []
    password = "app-pass-1"
    starttls_offered = True
    refuse = set()
    fail_sends = 0

    def __init__(self, host, port, timeout=None, context=None):
        self.kind = "ssl" if context is not None else "plain"
        FakeSMTP.log.append(("open", self.kind, host, port))

    def ehlo(self):
        return 250, b"ok"

    def has_extn(self, name):
        return FakeSMTP.starttls_offered and name == "starttls"

    def starttls(self, context=None):
        FakeSMTP.log.append(("starttls",))

    def login(self, user, password):
        if password != FakeSMTP.password:
            raise smtplib.SMTPAuthenticationError(535, b"bad " + password.encode())

    def send_message(self, message):
        if message["To"] in FakeSMTP.refuse:
            raise smtplib.SMTPRecipientsRefused({message["To"]: (550, b"no such user")})
        if FakeSMTP.fail_sends:
            FakeSMTP.fail_sends -= 1
            raise smtplib.SMTPServerDisconnected("gone")
        FakeSMTP.sent.append(message)

    def quit(self):
        FakeSMTP.log.append(("quit",))


def resolver(host, port):
    address = "10.0.0.5" if host.startswith("intranet") else "93.184.216.34"
    return [(2, 1, 6, "", (address, port))]


E._IMAP_SSL = E._IMAP = FakeIMAP
E._SMTP_SSL = E._SMTP = FakeSMTP
E._RESOLVER = resolver
account = {"address": "shop@store.pk", "username": "shop@store.pk", "password": "app-pass-1",
           "imap_host": "imap.store.pk", "imap_port": 993, "smtp_host": "smtp.store.pk", "smtp_port": 465}
box = E.open_imap(account)
check("IMAP 993 = implicit TLS with a timeout", FakeIMAP.log[0] == ("open", "ssl", "imap.store.pk", 993,
                                                                    E.TIMEOUT_SECONDS) and box.kind == "ssl")
FakeIMAP.log.clear()
E.open_imap(dict(account, imap_port=143))
check("IMAP 143 = STARTTLS before login", [x[0] for x in FakeIMAP.log] == ["open", "starttls", "login"])
FakeSMTP.log.clear()
E.open_smtp(account)
E.open_smtp(dict(account, smtp_port=587))
check("SMTP 465 = implicit TLS, 587 = STARTTLS", FakeSMTP.log[0][1] == "ssl"
      and FakeSMTP.log[1][1] == "plain" and FakeSMTP.log[2] == ("starttls",))
FakeSMTP.starttls_offered = False
try:
    E.open_smtp(dict(account, smtp_port=25))
    msg = ""
except E.EmailError as error:
    msg = str(error)
FakeSMTP.starttls_offered = True
check("SMTP without STARTTLS refused (never plain-text passwords)", "does not offer encryption" in msg, msg)
for opener, label in ((E.open_imap, "IMAP"), (E.open_smtp, "SMTP")):
    try:
        opener(dict(account, password="wrong-pass"))
        msg = ""
    except E.EmailError as error:
        msg = str(error)
    check(label + " bad password -> owner message without the password", label + " sign-in failed" in msg
          and "wrong-pass" not in msg, msg)
    try:
        opener(dict(account, imap_host="intranet.store.pk", smtp_host="intranet.store.pk"))
        msg = ""
    except E.EmailError as error:
        msg = str(error)
    check(label + " to a private address refused before connecting", "public host name" in msg, msg)
FakeIMAP.fail_connect = True
try:
    E.open_imap(account)
    msg = ""
except E.EmailError as error:
    msg = str(error)
FakeIMAP.fail_connect = False
check("unreachable IMAP -> owner message", "Could not reach the IMAP server imap.store.pk:993" in msg, msg)

FakeIMAP.box["mails"] = {1: b"a", 2: b"b", 3: b"c"}
box = E.open_imap(account)
check("nothing newer: IMAP's 'n:*' still returns the last UID - filtered out", E.fetch_new(box, 3) == [])
got = E.fetch_new(box, 1)
check("newer UIDs only, oldest first, with size", [(u, n) for u, n, _ in got] == [(2, 1), (3, 1)], got)
FakeIMAP.box["mails"] = {}

print("== tick throttle ==")
started = []


class NoThread:
    def __init__(self, target=None, args=(), name="", daemon=False):
        started.append(args)

    def start(self):
        pass


real_thread = E.threading.Thread
E.threading.Thread = NoThread
check("kick: first call starts, a second while it runs does not",
      E.kick(7) is True and E.kick(7) is False and started == [(7,)])
E._RUNNING.clear()
check("kick: finished, but still inside the poll window -> no new run", E.kick(7) is False and started == [(7,)])
E._RUNNING.clear()
check("kick: other workspace independent; bad ids ignored",
      E.kick("8") is True and E.kick(0) is False and E.kick("x") is False and E.kick(None) is False)
E.ENABLED = False
E._LAST.clear()
E._RUNNING.clear()
check("kick: OF_EMAIL_CHANNEL=0 -> never", E.kick(9) is False)
check("run: off -> reason off", E.run(9)["reason"] == "off")
E.ENABLED = True
E.threading.Thread = real_thread
E._LAST.clear()
E._RUNNING.clear()

print("== HTTP guards (no database touched) ==")
app = Flask(__name__)
app.register_blueprint(E.bp)
client = app.test_client()
URL = "/api/v1/portal/channels/email"
current_p = {"p": None, "exc": None}


def fake_auth():
    if current_p["exc"]:
        raise current_p["exc"]
    return current_p["p"]


E.authenticate_portal_request = fake_auth
db_calls = []
real_conn = portal_db._conn
portal_db._conn = lambda: db_calls.append(1) or (_ for _ in ()).throw(RuntimeError("db down"))
owner = {"client_id": 7, "user_id": 1, "role": "owner", "via_api_key": False}
check("no session -> 401", client.get(URL).status_code == 401 and client.put(URL, json={}).status_code == 401
      and client.post(URL + "/test").status_code == 401 and client.post(URL + "/sync").status_code == 401)
current_p["exc"] = PortalAuthUnavailable("auth down")
check("auth unavailable -> 503", client.get(URL).status_code == 503)
current_p["exc"] = None
current_p["p"] = dict(owner, via_api_key=True)
check("API key -> 403 everywhere", all(r.status_code == 403 for r in (
    client.get(URL), client.put(URL, json={}), client.post(URL + "/test"), client.post(URL + "/sync"))))
current_p["p"] = dict(owner, role="agent")
check("non-editor: save and test -> 403", client.put(URL, json=BASE).status_code == 403
      and client.post(URL + "/test").get_json()["error"]["code"] == "forbidden")
current_p["p"] = owner
r = client.put(URL, data="nope", content_type="application/json")
check("PUT without a JSON object -> 400", r.status_code == 400)
check("refused requests never reach the database", not db_calls)
for method, url in (("get", URL), ("put", URL), ("post", URL + "/test"), ("post", URL + "/sync")):
    response = getattr(client, method)(url, json=BASE)
    check(method.upper() + " " + url + ": database down -> 503 without internals",
          response.status_code == 503 and response.get_json()["error"]["code"] == "portal_unavailable"
          and "db down" not in json.dumps(response.get_json()), response.get_json())
portal_db._conn = real_conn


def run_db():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="email243_")
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

    r = client.get(URL)
    fresh = r.get_json()
    check("fresh db: GET 200 with defaults", r.status_code == 200 and fresh["address"] == ""
          and fresh["enabled"] is False and fresh["password_set"] is False and fresh["can_edit"] is True
          and fresh["available"] is True and fresh["poll_seconds"] == E.POLL_SECONDS, fresh)
    check("fresh db: reading creates nothing",
          sql("SELECT to_regclass('portal_email_accounts'), to_regclass('portal_email_threads')")[0] == (None, None))
    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)
    import portal_events
    c = portal_db._conn()
    import portal_identity
    with c.cursor() as cur:
        portal_events._ensure_ddl(cur)
        portal_identity._ensure_ddl(cur)
    c.commit()
    c.close()
    connector_api._ensure_away_table()

    check("sync before setup -> 409", client.post(URL + "/sync").status_code == 409)
    check("test before setup -> 409", client.post(URL + "/test").status_code == 409)
    r = client.put(URL, json=dict(BASE, enabled=True))
    check("save with enabled before a test -> 400", r.status_code == 400
          and "Test connection" in r.get_json()["error"]["message"])
    r = client.put(URL, json=BASE)
    body = r.get_json()
    stored = sql("SELECT password, enabled, verified_at FROM portal_email_accounts WHERE client_id = 7")[0]
    check("save: 200, password sealed in the database, never returned",
          r.status_code == 200 and stored[0].startswith("ofv1:") and "app-pass-1" not in stored[0]
          and "password" not in body and body["password_set"] is True and body["enabled"] is False
          and "app-pass-1" not in json.dumps(body), (stored, body))
    check("save audited", sql("SELECT COUNT(*) FROM portal_action_log WHERE client_id = 7"
                              " AND action = 'settings.email_channel'")[0][0] == 1)

    # three old emails are already in the mailbox
    FakeIMAP.box["mails"] = {1: mail(msgid="<old1@x.pk>"), 2: mail(msgid="<old2@x.pk>"),
                             3: mail(msgid="<old3@x.pk>")}
    r = client.put(URL, json=dict(BASE, imap_host="intranet.store.pk"))
    r = client.post(URL + "/test")
    check("test against a private host -> 400 provider_error, saved as last_error",
          r.status_code == 400 and r.get_json()["error"]["code"] == "provider_error"
          and "public host" in sql("SELECT last_error FROM portal_email_accounts WHERE client_id = 7")[0][0])
    client.put(URL, json=BASE)
    FakeIMAP.password = "other"
    r = client.post(URL + "/test")
    check("test with a wrong password -> 400 IMAP sign-in failed", r.status_code == 400
          and "IMAP sign-in failed" in r.get_json()["error"]["message"])
    FakeIMAP.password = "app-pass-1"
    r = client.post(URL + "/test")
    body = r.get_json()
    cursor = sql("SELECT uid_validity, last_uid, enabled, verified_at IS NOT NULL, last_error"
                 " FROM portal_email_accounts WHERE client_id = 7")[0]
    check("test passes: verified, turned on, cursor at the mailbox end, error cleared",
          r.status_code == 200 and body["ok"] is True and body["verified"] is True and body["enabled"] is True
          and cursor == (11, 3, True, True, ""), (body, cursor))

    brain_calls = []
    import portal_brain
    real_answer = portal_brain.maybe_answer
    portal_brain.maybe_answer = lambda *args, **kw: brain_calls.append(args[2]) and None

    res = E.run(7, manual=True)
    check("old mail is never imported", res["ran"] and res["imported"] == 0
          and sql("SELECT COUNT(*) FROM portal_conversations WHERE channel = 'email'")[0][0] == 0, res)

    FakeIMAP.box["mails"].update({
        4: mail(),
        5: mail(sender="Store <shop@store.pk>", msgid="<own@store.pk>"),
        6: mail(sender="Bank <no-reply@bank.pk>", msgid="<nr@bank.pk>"),
        7: mail(headers={"Auto-Submitted": "auto-replied"}, msgid="<ooo@customer.pk>"),
    })
    FakeIMAP.log.clear()
    res = E.run(7, manual=True)
    conv = sql("SELECT id, contact_id, contact_name, last_message_preview FROM portal_conversations"
               " WHERE client_id = 7 AND channel = 'email'")
    msgs = sql("SELECT direction, body, status FROM portal_messages WHERE conversation_id = %s", (conv[0][0],))
    check("new mail: 1 imported, 3 robots / own skipped",
          res["imported"] == 1 and res["skipped"] == 3 and res["error"] == "", res)
    check("conversation on the email channel with the sender's address and name",
          conv and conv[0][1] == "em:ali@customer.pk" and conv[0][2] == "Ali Khan", conv)
    check("message body through the shared ingest",
          msgs == [("in", "Subject: Order #12 late\n\nMera order kahan hai?", "received")], msgs)
    check("brain consulted once, for the customer", brain_calls == ["em:ali@customer.pk"], brain_calls)
    thread_row = sql("SELECT message_id, subject, refs FROM portal_email_threads"
                     " WHERE client_id = 7 AND contact_id = 'em:ali@customer.pk'")
    check("thread remembered", thread_row == [("<m1@customer.pk>", "Order #12 late", "<m1@customer.pk>")],
          thread_row)
    check("cursor advanced to the newest UID; counter", sql(
        "SELECT last_uid, imported_count FROM portal_email_accounts WHERE client_id = 7")[0] == (7, 1))
    check("mailbox opened read-only; every fetch is BODY.PEEK (stays unread)",
          ("select", "INBOX", True) in FakeIMAP.log
          and all("BODY.PEEK[]<0." in x[3] for x in FakeIMAP.log if x[:2] == ("uid", "FETCH"))
          and not any(x[:2] == ("uid", "STORE") for x in FakeIMAP.log))
    check("sender linked as an email identity (named)", sql(
        "SELECT i.display_name FROM portal_identity_handles h JOIN portal_identities i ON i.id = h.identity_id"
        " WHERE h.client_id = 7 AND h.channel = 'email' AND h.handle = 'ali@customer.pk'") == [("Ali Khan",)])

    sql("UPDATE portal_email_accounts SET last_uid = 3 WHERE client_id = 7", fetch=False)
    res = E.run(7, manual=True)
    check("re-reading the same emails: Message-ID dedupe keeps one message",
          sql("SELECT COUNT(*) FROM portal_messages WHERE conversation_id = %s", (conv[0][0],))[0][0] == 1
          and len(brain_calls) == 1, res)

    # foreign workspace 8: same contact, its own thread + queued email command
    sql("INSERT INTO portal_email_threads (client_id, contact_id, message_id, subject, refs)"
        " VALUES (8, 'em:ali@customer.pk', '<w8@x.pk>', 'Workspace 8 subject', '')", fetch=False)

    def queue(client_id, action, payload, channel="email"):
        return sql("INSERT INTO portal_connector_commands (client_id, channel, action, payload, status)"
                   " VALUES (%s, %s, %s, %s::jsonb, 'pending') RETURNING id",
                   (client_id, channel, action, json.dumps(payload)))[0][0]

    contact = "em:ali@customer.pk"
    manual_id = queue(7, "send_message", {"external_user_id": contact, "body": "Ji, kal deliver hoga.",
                                          "source": "manual"})
    ai_id = queue(7, "send_message", {"external_user_id": contact, "body": "Tracking: TCS 123",
                                      "source": "ai_brain"})
    media_id = queue(7, "send_media", {"external_user_id": contact, "asset_id": 4})
    foreign_id = queue(8, "send_message", {"external_user_id": contact, "body": "w8", "source": "manual"})
    wa_id = queue(7, "send_message", {"external_user_id": "923001234567", "body": "wa"}, channel="whatsapp")

    print("== laptop bridges never see email work ==")
    capp = Flask("connector")
    capp.register_blueprint(connector_api.bp)
    cclient = capp.test_client()
    headers = {"X-Omniflow-Key": os.environ["OMNIFLOW_SERVICE_KEY"]}
    real_kick = E.kick
    E.kick = lambda cid: False
    r = cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&limit=50", headers=headers)
    ids = [cmd["id"] for cmd in r.get_json()["commands"]]
    check("unfiltered poll: WhatsApp work yes, email commands no",
          r.status_code == 200 and wa_id in ids and not {manual_id, ai_id, media_id} & set(ids), ids)
    r = cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&channel=email", headers=headers)
    check("a bridge asking for channel=email -> 400", r.status_code == 400
          and "email" not in r.get_json()["error"]["message"], r.get_json())
    r = cclient.get("/api/v1/connector/whatsapp/commands?client_id=7&channel=telegram", headers=headers)
    check("other channel filters unchanged", r.status_code == 200)
    sql("INSERT INTO portal_away_replies (client_id, conversation_id, contact_id, body)"
        " VALUES (7, NULL, 'em:sara@customer.pk', 'Hum abhi band hain'),"
        " (7, NULL, '923001112222', 'Hum abhi band hain')", fetch=False)
    r = cclient.get("/api/v1/connector/away-replies?client_id=7&limit=20", headers=headers)
    away_users = [a["external_user_id"] for a in r.get_json()["away_replies"]]
    check("laptop away-reply poll skips email contacts", away_users == ["923001112222"], away_users)
    E.kick = real_kick

    print("== sending ==")
    FakeSMTP.sent.clear()
    res = E.run(7, manual=True)
    sent = {str(m["To"]): m for m in FakeSMTP.sent}
    check("two replies + the away reply sent; media refused", res["sent"] == 3 and res["refused"] == 1
          and len(FakeSMTP.sent) == 3, res)
    first, second = FakeSMTP.sent[0], FakeSMTP.sent[1]
    check("replies go into the customer's thread (this workspace's subject, not workspace 8's)",
          first["To"] == "ali@customer.pk" and first["Subject"] == "Re: Order #12 late"
          and first["In-Reply-To"] == "<m1@customer.pk>" and first.get_content().strip() == "Ji, kal deliver hoga.",
          str(first)[:400])
    check("human reply has no Auto-Submitted; the AI reply has it",
          first["Auto-Submitted"] is None and second["Auto-Submitted"] == "auto-replied")
    check("second reply references the first", str(first["Message-ID"]) in str(second["References"]))
    check("away reply for an email contact sent by email (default subject, auto)",
          sent["sara@customer.pk"]["Subject"] == "Message from Store PK"
          and sent["sara@customer.pk"]["Auto-Submitted"] == "auto-replied")
    rows = dict((r[0], r[1:]) for r in sql(
        "SELECT id, status, provider_message_id, error_code FROM portal_connector_commands"
        " WHERE id IN (%s, %s, %s, %s)", (manual_id, ai_id, media_id, foreign_id)))
    check("commands: done with the Message-ID; media dead (refused, no retry); workspace 8 untouched",
          rows[manual_id] == ("done", str(first["Message-ID"]), None)
          and rows[ai_id][0] == "done" and rows[media_id] == ("dead", None, "refused")
          and rows[foreign_id] == ("pending", None, None), rows)
    check("away replies: email one sent, WhatsApp one left for the laptop", sql(
        "SELECT contact_id, status FROM portal_away_replies WHERE client_id = 7 ORDER BY id")
        == [("em:sara@customer.pk", "sent"), ("923001112222", "pending")])
    out_rows = sql("SELECT body FROM portal_messages WHERE conversation_id = %s AND direction = 'out'"
                   " ORDER BY id", (conv[0][0],))
    check("sent replies recorded in the conversation", [r[0] for r in out_rows]
          == ["Ji, kal deliver hoga.", "Tracking: TCS 123"], out_rows)
    check("recording our own replies never wakes the brain", len(brain_calls) == 1, brain_calls)
    check("sent counter", sql("SELECT sent_count FROM portal_email_accounts WHERE client_id = 7")[0][0] == 3)
    check("workspace 8 thread untouched", sql(
        "SELECT subject FROM portal_email_threads WHERE client_id = 8")[0][0] == "Workspace 8 subject")

    FakeSMTP.sent.clear()
    FakeSMTP.fail_sends = 1
    retry_id = queue(7, "send_message", {"external_user_id": contact, "body": "retry me", "source": "manual"})
    refused_id = queue(7, "send_message", {"external_user_id": "em:gone@customer.pk", "body": "x",
                                           "source": "manual"})
    FakeSMTP.refuse = {"gone@customer.pk"}
    res = E.run(7, manual=True)
    rows = dict((r[0], r[1:]) for r in sql(
        "SELECT id, status, attempts, next_attempt_at IS NOT NULL, error_code FROM portal_connector_commands"
        " WHERE id IN (%s, %s)", (retry_id, refused_id)))
    check("temporary failure -> retry scheduled (attempt 1, backoff)", rows[retry_id][:3] == ("pending", 1, True),
          rows)
    check("recipient rejected -> dead (refused, no retry)", rows[refused_id][0] == "dead"
          and rows[refused_id][3] == "refused", rows)
    FakeSMTP.refuse = set()
    sql("UPDATE portal_connector_commands SET next_attempt_at = NOW() - INTERVAL '1 second'"
        " WHERE id = %s", (retry_id,), fetch=False)
    res = E.run(7, manual=True)
    check("retry later succeeds", sql("SELECT status FROM portal_connector_commands WHERE id = %s",
                                      (retry_id,))[0][0] == "done" and res["sent"] == 1, res)

    late_id = queue(7, "send_message", {"external_user_id": contact, "body": "smtp down", "source": "manual"})
    FakeSMTP.password = "changed"
    FakeIMAP.box["mails"][8] = mail(msgid="<m8@customer.pk>", subject="Re: Order #12 late",
                                    reply_to="<m1@customer.pk>", body="Ok shukriya")
    res = E.run(7, manual=True)
    row = sql("SELECT status, attempts FROM portal_connector_commands WHERE id = %s", (late_id,))[0]
    err = sql("SELECT last_error FROM portal_email_accounts WHERE client_id = 7")[0][0]
    check("SMTP sign-in broken: reply stays queued (no attempt burnt), error shown, import still runs",
          row == ("pending", 0) and "SMTP sign-in failed" in err and res["imported"] == 1
          and res["error"] == err, (row, err, res))
    FakeSMTP.password = "app-pass-1"
    res = E.run(7, manual=True)
    check("fixed: the queued reply goes out and the error clears", res["sent"] == 1 and sql(
        "SELECT last_error FROM portal_email_accounts WHERE client_id = 7")[0][0] == "")

    print("== guards ==")
    res = E.run(7)
    check("automatic run inside the poll window -> recent (nothing done)", res["reason"] == "recent"
          and not res["ran"], res)
    holder = connect()
    hc = holder.cursor()
    hc.execute("SELECT pg_advisory_lock(%s, %s)", (E.LOCK_CLASS, 7))
    res = E.run(7, manual=True)
    r = client.post(URL + "/sync")
    hc.execute("SELECT pg_advisory_unlock(%s, %s)", (E.LOCK_CLASS, 7))
    holder.close()
    check("another run holds the workspace lock -> busy; Check now -> 409", res["reason"] == "busy"
          and r.status_code == 409 and r.get_json()["error"]["code"] == "busy", res)
    current_p["p"] = dict(owner, role="agent")
    r = client.post(URL + "/sync")
    check("any team member can Check now", r.status_code == 200 and r.get_json()["ran"] is True, r.get_json())
    current_p["p"] = owner
    check("lock released after a run", E.run(7, manual=True)["reason"] == "")

    FakeIMAP.box["validity"] = 12
    FakeIMAP.box["mails"][9] = mail(msgid="<m9@customer.pk>")
    res = E.run(7, manual=True)
    check("UIDVALIDITY changed -> cursor restarts at the end, nothing re-imported",
          res["imported"] == 0 and sql("SELECT uid_validity, last_uid FROM portal_email_accounts"
                                       " WHERE client_id = 7")[0] == (12, 9), res)
    FakeIMAP.box["mails"][10] = mail(msgid="<m10@customer.pk>", body="naya")
    real_ingest = connector_api.ingest_messages_for_tenant

    def limited(*args, **kwargs):
        raise connector_api.IngestRateLimited()

    connector_api.ingest_messages_for_tenant = limited
    res = E.run(7, manual=True)
    connector_api.ingest_messages_for_tenant = real_ingest
    check("rate limited -> cursor kept, friendly error", sql(
        "SELECT last_uid FROM portal_email_accounts WHERE client_id = 7")[0][0] == 9
        and "next check" in res["error"], res)
    res = E.run(7, manual=True)
    check("next check imports it", res["imported"] == 1 and sql(
        "SELECT last_uid FROM portal_email_accounts WHERE client_id = 7")[0][0] == 10, res)

    FakeIMAP.box["mails"][11] = mail(msgid="<m11@customer.pk>", body="unread yet")
    r = client.post(URL + "/test")
    check("re-testing a working mailbox keeps the cursor (unread new mail is not skipped)",
          r.status_code == 200 and sql("SELECT last_uid FROM portal_email_accounts WHERE client_id = 7")[0][0] == 10)
    real_max = E.MAX_BYTES
    E.MAX_BYTES = 60_000
    FakeIMAP.box["mails"][12] = mail(msgid="<m12@customer.pk>", subject="Re: big", reply_to="<m1@customer.pk>",
                                     body="Bari email " + "x" * 30, attach=None,
                                     headers={"X-Pad": "y" * 70_000})
    res = E.run(7, manual=True)
    E.MAX_BYTES = real_max
    bodies = [r[0] for r in sql("SELECT body FROM portal_messages WHERE client_id = 7 AND direction = 'in'"
                                " ORDER BY id DESC LIMIT 2")]
    check("both imported; an email over the size cap is read partially and says so",
          res["imported"] == 2 and "unread yet" in bodies[1]
          and bodies[0].endswith("open it in the mailbox for the full message.]"), (res, bodies))

    r = client.put(URL, json=dict(BASE, password="", enabled=False))
    check("turn off (blank password kept): stays verified, no run", r.get_json()["enabled"] is False
          and r.get_json()["verified"] is True and E.run(7, manual=True)["reason"] == "not_connected")
    r = client.put(URL, json=dict(BASE, password="", enabled=True))
    check("turn back on without retesting (same credentials)", r.status_code == 200 and r.get_json()["enabled"])
    r = client.put(URL, json=dict(BASE, smtp_host="smtp2.store.pk", password=""))
    after = sql("SELECT enabled, verified_at, last_uid FROM portal_email_accounts WHERE client_id = 7")[0]
    check("changed server -> off, must test again, cursor cleared", after == (False, None, None), after)
    check("workspace 8 email command still pending after all runs", sql(
        "SELECT status FROM portal_connector_commands WHERE id = %s", (foreign_id,))[0][0] == "pending")
    portal_brain.maybe_answer = real_answer

    import portal_db as pdb
    real = pdb._conn
    pdb._conn = lambda: (_ for _ in ()).throw(RuntimeError("db down"))
    res = E.run(7, manual=True)
    pdb._conn = real
    check("run never raises (database down -> unavailable)", res["reason"] == "unavailable" and not res["ran"])


run_db()
summary("email_channel")
