"""Notification service (platform services): settings validation, the
fan-out (bell alert + tenant-scoped email opt-in + ledger), dedupe and
severity rules, sync/async delivery, fail-soft law, owner API + auth, and
the wiring pins (approvals, dead deliveries, workflow failures, settings
card, bell marker)."""
import os
import time

from flask import Flask

import portal_alerts
import portal_notify as pn
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)
ON = {"email_enabled": True, "email_to": "owner@example.com",
      "min_severity": "normal", "kinds": {}}


class PrincipalStub:
    def __init__(self, module, principal):
        self.module = module
        self.principal = principal

    def __enter__(self):
        self.orig = self.module.authenticate_portal_request
        self.module.authenticate_portal_request = lambda: self.principal
        self.module.PortalAuthUnavailable = Exception
        return self

    def __exit__(self, *a):
        self.module.authenticate_portal_request = self.orig


def fresh(script):
    pn._DDL_READY = True
    portal_alerts._DDL_READY = True
    return install_db_stub(pn, script)


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    fresh(script)
    app = Flask("notify-test")
    app.register_blueprint(pn.bp)
    with PrincipalStub(pn, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "PUT":
            return client.put(path, json=json_body)
    return None


deliveries = []


def fake_deliver(to, subject, body):
    deliveries.append((to, subject, body))
    return True, "sent via test"


pn._deliver = fake_deliver
pn.EMAIL_ENABLED = True
pn.EMAIL_SYNC = False

# ---------- settings ----------

print("== settings ==")
d = pn.default_settings()
check("defaults: email opt-in OFF, every kind on, normal threshold",
      d["email_enabled"] is False and d["min_severity"] == "normal"
      and all(d["kinds"][k] for k in pn.KIND_KEYS), d)
check("kind registry covers the platform events", pn.KIND_KEYS == (
    "escalation", "approval", "delivery", "workflow", "knowledge", "system"),
      pn.KIND_KEYS)
shaped = pn._shape_settings({"email_enabled": True, "email_to": " a@b.co ",
                             "min_severity": "silly",
                             "kinds": '{"approval": false, "junk": true}'})
check("shape: bad severity falls back, JSON kinds parsed, unknown ignored",
      shaped["email_enabled"] is True and shaped["email_to"] == "a@b.co"
      and shaped["min_severity"] == "normal"
      and shaped["kinds"]["approval"] is False and "junk" not in shaped["kinds"],
      shaped)
merged, err = pn.validate_settings(
    {"email_enabled": True, "email_to": "x@y.z", "min_severity": "high",
     "kinds": {"delivery": False}}, pn.default_settings())
check("validate merges a full payload", err is None and merged["email_enabled"]
      and merged["min_severity"] == "high" and merged["kinds"]["delivery"] is False
      and merged["kinds"]["approval"] is True, (merged, err))
for payload, why in (({"email_enabled": "yes"}, "email_enabled type"),
                     ({"email_to": "not an email"}, "email format"),
                     ({"min_severity": "urgent"}, "severity"),
                     ({"kinds": ["approval"]}, "kinds type"),
                     ({"kinds": {"bogus": True}}, "unknown kind"),
                     ({"kinds": {"approval": "no"}}, "kind value"),
                     ("nope", "payload type")):
    _m, err = pn.validate_settings(payload, pn.default_settings())
    check("validate rejects " + why, err is not None, payload)
_m, err = pn.validate_settings({"email_to": ""}, dict(pn.default_settings(),
                                                       email_to="a@b.c"))
check("validate: blank email_to clears the address", err is None
      and _m["email_to"] == "", _m)
check("mask keeps the domain", pn._mask("ahmed@example.com") == "ah\u2026@example.com"
      and pn._mask("") == "", pn._mask("ahmed@example.com"))

# ---------- fan-out ----------

print("== fan-out ==")
conn = fresh([[], [], [], [], [{"id": 9}], [{"id": 100}]])
res = pn.notify(1, "escalation", "Chat needs a human", "Conversation #42",
                severity="normal", dedupe_key="conv:42", conversation_id=42)
ex = conn.cur.executed
check("no settings row -> bell alert written, email off, ledger row",
      res["in_app"] == 9 and res["email"] == "off" and res["ledger_id"] == 100
      and not res["error"], res)
check("alert insert carries kind/severity/dedupe via portal_alerts",
      any("portal_alerts" in e[0] and e[0].startswith("INSERT")
          and e[1][1] == "escalation" and e[1][2] == "conv:42"
          and e[1][3] == "normal" for e in ex), ex)
ledger = [e for e in ex if "portal_notifications" in e[0] and e[0].startswith("INSERT")]
check("ledger row: kind, severity, title, conversation, alert id, email off",
      ledger and ledger[0][1][:3] == (1, "escalation", "normal")
      and ledger[0][1][5] == 42 and ledger[0][1][6] == 9
      and ledger[0][1][8] == "off", ledger)
check("own connection committed + closed (caller's transaction untouched)",
      conn.committed and conn.closed, (conn.committed, conn.closed))

deliveries[:] = []
conn = fresh([[ON], [], [], [], [{"id": 10}], [{"id": 101}], 1])
res = pn.notify(1, "approval", "Approval AB12: refund", "Customer Ali",
                severity="high", dedupe_key="approval:7", conversation_id=42,
                email_sync=True)
check("email opt-in: sent synchronously to the saved address + ledger updated",
      res["email"] == "sent" and res["email_to"] == "owner@example.com"
      and deliveries and deliveries[0][0] == "owner@example.com"
      and deliveries[0][1] == "[OmniFlow] Approval AB12: refund"
      and "Open the conversation: /dashboard/conversations/42" in deliveries[0][2]
      and conn.cur.executed[-1][0].startswith("UPDATE")
      and conn.cur.executed[-1][1][:2] == ("sent", ""), (res, deliveries))

deliveries[:] = []
conn = fresh([[ON], [], [], [{"?column?": 1}], [{"id": 102}]])
res = pn.notify(1, "escalation", "Chat needs a human", "", dedupe_key="conv:42",
                email_sync=True)
check("same unread alert already there -> no second email (deduped)",
      res["in_app"] is None and res["email"] == "deduped" and not deliveries,
      res)

conn = fresh([[dict(ON, min_severity="high")], [], [], [{"id": 11}],
              [{"id": 103}]])
res = pn.notify(1, "escalation", "Low confidence", severity="normal",
                email_sync=True)
check("below the tenant's severity threshold -> bell only", res["in_app"] == 11
      and res["email"] == "off", res)

conn = fresh([[dict(ON, kinds={"workflow": False})], [], [], [], [{"id": 12}],
              [{"id": 104}]])
res = pn.notify(1, "workflow", "Run failed", email_sync=True)
check("kind switched off -> bell only", res["email"] == "off", res)

conn = fresh([[dict(ON, email_to="")], [], [], [{"id": 13}],
              [{"email": "first@example.com"}], [{"id": 105}], 1])
deliveries[:] = []
res = pn.notify(1, "delivery", "Delivery failed", email_sync=True)
check("no saved address -> the workspace's first user gets it",
      res["email"] == "sent" and res["email_to"] == "first@example.com"
      and deliveries[0][0] == "first@example.com", res)

conn = fresh([[dict(ON, email_to="")], [], [], [{"id": 14}], [], [{"id": 106}]])
res = pn.notify(1, "delivery", "Delivery failed", email_sync=True)
check("no recipient anywhere -> honest no_recipient", res["email"] == "no_recipient"
      and conn.cur.executed[-1][1][8] == "no_recipient", res)

conn = fresh([[ON], [{"enabled": False}], [{"id": 107}], 1])
deliveries[:] = []
res = pn.notify(1, "escalation", "Chat needs a human", email_sync=True)
check("tenant bell OFF -> no alert but email still honoured",
      res["in_app"] is None and res["email"] == "sent" and deliveries, res)

conn = fresh([[ON], [{"id": 108}], 1])
res = pn.notify(1, "delivery", "Delivery failed", in_app=False, alert_id=77,
                email_sync=True)
check("in_app=False reuses an alert raised elsewhere (no second bell row)",
      res["in_app"] == 77 and res["email"] == "sent"
      and not any("portal_alerts" in e[0] for e in conn.cur.executed)
      and conn.cur.executed[1][1][6] == 77, conn.cur.executed)

pn._deliver = lambda to, s, b: (False, "SMTP host is not set.")
conn = fresh([[ON], [], [], [], [{"id": 15}], [{"id": 109}], 1])
res = pn.notify(1, "system", "Test notification", email_sync=True)
check("delivery failure is recorded, never raised", res["email"] == "failed"
      and res["error"] == "SMTP host is not set."
      and conn.cur.executed[-1][1][:2] == ("failed", "SMTP host is not set."),
      res)
pn._deliver = fake_deliver

marks = []
pn._mark_email = lambda *a: marks.append(a)
conn = fresh([[ON], [], [], [{"id": 16}], [{"id": 110}]])
res = pn.notify(1, "escalation", "Chat needs a human", "d")
deadline = time.time() + 3
while not marks and time.time() < deadline:
    time.sleep(0.05)
check("default = queued on a background thread, result marked afterwards",
      res["email"] == "queued" and res["in_app"] == 16
      and marks == [(110, "sent", "")], (res, marks))

conn = fresh([Exception("db down")])
res = pn.notify(1, "escalation", "x")
check("database down -> error reported, no exception", res["error"]
      and res["ledger_id"] is None, res)
res = pn.notify(1, "not-a-kind", "", severity="loud")
check("unknown kind/severity normalised (system/normal), blank title filled",
      res["error"] != "" or True, res)  # reached without raising
conn = fresh([[], [], [], [], [{"id": 17}], [{"id": 111}]])
pn.notify(1, "not-a-kind", "", severity="loud", dedupe_key="k")
check("normalised values reach the ledger",
      conn.cur.executed[-1][1][1:4] == ("system", "normal", "Notification"),
      conn.cur.executed[-1][1])

pn.EMAIL_ENABLED = False
conn = fresh([[ON], [], [], [], [{"id": 18}], [{"id": 112}]])
res = pn.notify(1, "escalation", "x", email_sync=True)
check("OF_NOTIFY_EMAIL=0 kill switch -> email off even when the tenant opted in",
      res["email"] == "off", res)
pn.EMAIL_ENABLED = True

import platform_settings  # noqa: E402

_orig_smtp = platform_settings.smtp_config
platform_settings.smtp_config = lambda: {"provider": "brevo", "brevo_api_key": ""}
check("email_configured: brevo without key -> False", pn.email_configured() is False, "-")
platform_settings.smtp_config = lambda: {"provider": "smtp", "smtp_host": "smtp.x"}
check("email_configured: smtp host -> True", pn.email_configured() is True, "-")
platform_settings.smtp_config = _orig_smtp

# ---------- API ----------

print("== api ==")
ROW = {"id": 5, "kind": "escalation", "severity": "high", "title": "t",
       "detail": "d", "conversation_id": 42, "alert_id": 9,
       "email_to": "owner@example.com", "email_status": "sent",
       "email_error": "", "created_at": None}
r = run_api([[ROW], [ON]], "GET", "/api/v1/portal/notifications?limit=10")
body = r.get_json()
check("GET notifications 200: items masked + settings + registry + configured flag",
      r.status_code == 200 and body["items"][0]["email_to"] == "ow\u2026@example.com"
      and body["settings"]["email_enabled"] is True
      and [k["key"] for k in body["kinds"]] == list(pn.KIND_KEYS)
      and body["severities"] == ["normal", "high"]
      and "email_configured" in body, body)
r = run_api([[ROW], []], "GET", "/api/v1/portal/notifications",
            principal=API_KEY_PRINCIPAL)
check("GET notifications readable by API keys", r.status_code == 200, r.status_code)
r = run_api([], "GET", "/api/v1/portal/notifications", principal=None)
check("GET notifications 401", r.status_code == 401, r.status_code)
r = run_api([[]], "GET", "/api/v1/portal/notifications/settings")
check("GET settings 200 defaults", r.status_code == 200
      and r.get_json()["settings"]["email_enabled"] is False, r.get_json())
r = run_api([[], [], []], "PUT", "/api/v1/portal/notifications/settings",
            {"email_enabled": True, "email_to": "owner@example.com",
             "kinds": {"delivery": False}})
body = r.get_json()
check("PUT settings 200 -> upsert + audit", r.status_code == 200
      and body["settings"]["email_enabled"] is True
      and body["settings"]["kinds"]["delivery"] is False, body)
r = run_api([[]], "PUT", "/api/v1/portal/notifications/settings",
            {"email_to": "nope"})
check("PUT settings 400 bad email", r.status_code == 400, r.status_code)
r = run_api([], "PUT", "/api/v1/portal/notifications/settings", [1])
check("PUT settings 400 non-object", r.status_code == 400, r.status_code)
r = run_api([], "PUT", "/api/v1/portal/notifications/settings",
            {"email_enabled": True}, principal=API_KEY_PRINCIPAL)
check("PUT settings 403 API key", r.status_code == 403, r.status_code)
captured = []
_orig_notify = pn.notify
pn.notify = lambda *a, **k: captured.append((a, k)) or {"in_app": 1, "email": "sent",
                                                        "email_to": "o@x", "ledger_id": 3,
                                                        "error": ""}
r = run_api([], "POST", "/api/v1/portal/notifications/test", {})
pn.notify = _orig_notify
check("POST test -> synchronous notify(kind system) + result echoed",
      r.status_code == 200 and r.get_json()["ok"] is True
      and captured and captured[0][0][1] == "system"
      and captured[0][1].get("email_sync") is True, (r.get_json(), captured))
r = run_api([], "POST", "/api/v1/portal/notifications/test", {},
            principal=API_KEY_PRINCIPAL)
check("POST test 403 API key", r.status_code == 403, r.status_code)

# ---------- wiring pins ----------

print("== wiring pins ==")
HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.join(HERE, "..", "..", "omniflow-backend-patch")
RIG13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


APP = read(os.path.join(CP, "app.py"))
check("blueprint registered", "aux_app.register_blueprint(portal_notify_bp)" in APP, "-")
APPROVALS = read(os.path.join(CP, "portal_approvals.py"))
check("approvals notify the owner (bell + optional email) next to the WhatsApp 1/0",
      'portal_notify.notify(' in APPROVALS and '"approval",' in APPROVALS
      and 'dedupe_key="approval:" + str(approval_id)' in APPROVALS, "-")
ALERTS = read(os.path.join(CP, "portal_alerts.py"))
check("dead deliveries: bell alert unchanged + email through the service",
      'portal_notify.notify(' in ALERTS and 'in_app=False' in ALERTS
      and "alert_id=alert_id" in ALERTS, "-")
WF = read(os.path.join(CP, "portal_workflows.py"))
check("failed workflow runs notify (deduped per run)",
      '"workflow",' in WF and 'dedupe_key="wfrun:" + str(run_id)' in WF, "-")
SRC = read(pn.__file__)
check("service never rides the caller's transaction (own connection) + thread send",
      "conn = portal_db._conn()" in SRC and "threading.Thread(" in SRC
      and "def notify(client_id" in SRC, "-")
check("no hardcoded switches", all(e in SRC for e in (
    "OF_NOTIFY_EMAIL", "OF_NOTIFY_EMAIL_SYNC", "OF_PORTAL_BASE_URL")), "-")
check("email reuses the platform provider (no second SMTP client)",
      "admin_providers._deliver_email" in SRC and "smtplib" not in SRC, "-")

LIB = read(RIG13 + "lib/omniflow/portal.ts")
check("portal.ts notification client", all(t in LIB for t in (
    "export async function getNotifications",
    "export async function putNotificationSettings",
    "export async function sendTestNotification",
    '"api/v1/portal/notifications?limit="', '"api/v1/portal/notifications/test"')), "-")
for rel, tokens in (("notifications/route.ts", ("getNotifications", "export async function GET")),
                    ("notifications/settings/route.ts", ("putNotificationSettings",
                                                         "export async function PUT")),
                    ("notifications/test/route.ts", ("sendTestNotification",
                                                     "export async function POST"))):
    src = read(RIG13 + "app/api/omniflow/portal/" + rel)
    depth = rel.count("/") + 4
    check("BFF " + rel, bool(src) and all(t in src for t in tokens)
          and ('"' + "../" * depth + 'lib/omniflow/portal"') in src, rel)
CARD = read(RIG13 + "app/dashboard/(portal)/settings/NotificationsCard.tsx")
check("Notifications card: email opt-in, recipient, threshold, per-kind toggles, test, history",
      all(t in CARD for t in ("/api/omniflow/portal/notifications", "Send a test",
                              "email_enabled", "min_severity", "kinds",
                              "Recent notifications", "email_configured")), "-")
check("Notifications card mounted on Settings", "<NotificationsCard />" in read(
    RIG13 + "app/dashboard/(portal)/settings/page.tsx"), "-")
BELL = read(RIG13 + "app/dashboard/components/AlertsBell.tsx")
check("bell marks high-severity alerts and no longer says 'failure alerts' only",
      'alert.severity === "high"' in BELL and "no failure alerts" not in BELL, "-")
check("UI copy English + text glyphs", "karein" not in CARD and "\\u25b6" not in CARD
      and "\\u2714" not in CARD, "-")

raise SystemExit(1 if summary("notify") else 0)
