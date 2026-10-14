"""§239 notification email templates + rate limits.

Units (template rules, rendering, the built-in email unchanged, limit
validation) + web pins, then the real thing on pgserver: the old tables
gain the new columns without losing rows, per-kind hourly caps for the bell
and email, the daily email cap, high severity skipping the hourly caps,
"Send a test" skipping all, the held-back count in the next email, tenant
isolation of the counts, templates used by real notifications (values can
never inject variables, one-line subjects), and the HTTP API (roles, API
keys, validation, reset, preview, test kind).
"""
import os
import re
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in list(os.environ):
    if name.startswith("OF_NOTIFY_"):
        os.environ.pop(name)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_notify as pn  # noqa: E402

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))


def web(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


print("== units ==")
check("defaults: 30 bell / 6 email per kind per hour, 40 emails a day",
      pn.default_settings()["bell_per_hour"] == 30 and pn.default_settings()["email_per_hour"] == 6
      and pn.default_settings()["email_per_day"] == 40 and pn.LIMIT_MAX == 500)
legacy = "Chat needs a human\n\nConversation #42\n\nOpen the conversation: /dashboard/conversations/42\n\n- OmniFlow"
check("built-in email is the old email", pn._email_body("Chat needs a human", "Conversation #42", 42) == legacy
      and pn._email_body("T", "", None) == "T\n\n- OmniFlow"
      and pn.render_email(None, "approval", "high", "T", "", None)[0] == "[OmniFlow] T")
subject, body = pn.render_email({"subject": "{kind}: {title}", "body": "{detail}\n{severity}"}, "escalation",
                                "high", "Ali says {detail}\nBcc: x@y.z", "uses {title}", None)
check("values go in once (no variable injection), subject is one line",
      subject == "Handoffs: Ali says {detail} Bcc: x@y.z" and body == "uses {title}\nhigh", (subject, body))
_s, body = pn.render_email(None, "system", "normal", "T", "", None, held=3)
check("held-back count added to the next email", body.endswith(
    "3 more notifications were held back by your email limits - see Settings > Notifications."), body)
_s, body = pn.render_email(None, "system", "normal", "T", "", None, held=1)
check("held-back: singular", "1 more notification was held back" in body, body)
for subj, text, why in (("", "{title}", "blank subject"), ("A\nB", "{title}", "two-line subject"),
                        ("x" * 201, "{title}", "long subject"), ("S", "x" * 2001 + "{title}", "long body"),
                        ("S {name}", "{title}", "unknown variable"), ("S", "Hello", "no title / detail"),
                        (None, "{title}", "not text")):
    cleaned, reason = pn.clean_template(subj, text)
    check("template rejected: " + why, cleaned is None and reason, (subj, reason))
cleaned, reason = pn.clean_template("  [Shop] {title} ", "Hi\r\n{detail}\r\n")
check("template cleaned (trim, CRLF)", cleaned == ("[Shop] {title}", "Hi\n{detail}") and not reason, cleaned)
merged, err = pn.validate_settings({"email_per_hour": 3, "email_per_day": 10, "bell_per_hour": 500}, pn.default_settings())
check("limits validate", err is None and merged["email_per_hour"] == 3 and merged["bell_per_hour"] == 500)
for value in (0, 501, True, 2.5, "3"):
    check("limit rejected: " + repr(value), pn.validate_settings({"email_per_day": value}, pn.default_settings())[1])
check("limit roles", pn.can_edit({"role": "owner"}) and pn.can_edit({"role": "Admin"})
      and not pn.can_edit({"role": "agent"}) and not pn.can_edit({}))
check("stored limits: NULL / junk = default", pn._shape_settings({"email_per_hour": None, "email_per_day": 0,
                                                                  "bell_per_hour": 12})["email_per_day"] == 40
      and pn._shape_settings({"bell_per_hour": 12})["bell_per_hour"] == 12)

print("== web pins ==")
PORTAL = web("lib/omniflow/portal.ts")
SECTION = PORTAL[PORTAL.index("// Notification email templates (§239)"):]
CARD = web("app/dashboard/(portal)/settings/NotificationsCard.tsx")
TPL = web("app/dashboard/(portal)/settings/NotificationTemplatesCard.tsx")
PAGE = web("app/dashboard/(portal)/settings/page.tsx")
SETTINGS = web("app/api/omniflow/portal/notifications/settings/route.ts")
TEST = web("app/api/omniflow/portal/notifications/test/route.ts")
LIST = web("app/api/omniflow/portal/notifications/templates/route.ts")
ONE = web("app/api/omniflow/portal/notifications/templates/[kind]/route.ts")
PREVIEW = web("app/api/omniflow/portal/notifications/templates/preview/route.ts")
check("portal.ts maps templates to camelCase", "updatedAt: typeof row.updated_at" in SECTION
      and "canEdit: raw.can_edit === true" in SECTION and "export function saveNotifyTemplate(" in SECTION
      and "export function resetNotifyTemplate(" in SECTION and "export function previewNotifyTemplate(" in SECTION)
check("portal.ts: limits + bell status + test kind", "email_per_day: number;" in PORTAL
      and "in_app_status: string;" in PORTAL and "body: JSON.stringify({ kind })," in PORTAL)
check("BFF writes are same-origin guarded", "if (!sameOrigin(request))" in SETTINGS and "if (!sameOrigin(request))" in TEST
      and ONE.count("}, request);") == 2 and "}, request);" in PREVIEW and "withPortalToken(" in LIST)
check("BFF: limits integers only, kinds validated", "Number.isInteger(value)" in SETTINGS
      and "/^[a-z_]{1,40}$/.test(kind)" in ONE and "/^[a-z_]{1,40}$/.test(body.kind)" in TEST)
check("card: limits for owners / admins only", "data?.can_edit ? { ...basic, bell_per_hour, email_per_hour, email_per_day } : basic"
      in CARD and "disabled={!data.can_edit || busy}" in CARD and 'limited: "email limit reached",' in CARD
      and 'item.in_app_status === "limited"' in CARD)
check("templates card: defaults as placeholders, preview, reset, test", "placeholder={view.defaults.subject}" in TPL
      and "placeholder={view.defaults.body}" in TPL and 'run("preview")' in TPL and 'run("reset")' in TPL
      and '"/api/omniflow/portal/notifications/test"' in TPL and "Only owners and admins can change email templates." in TPL)
check("templates card mounted after notifications", PAGE.index("<NotificationsCard />") < PAGE.index("<NotificationTemplatesCard />"))
EMOJI = "[\u25b6\u261d\u2714\u26a1\u2699\u2709\u260e\u2733\u263a\u25fc\u27a1]"
check("no emoji-capable glyphs / JSX apostrophes", not re.search(EMOJI, TPL + CARD)
      and not re.search(r">[^<{]*'[^<{]*<", TPL))


def database_half():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="notify239_")
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
    # the pre-239 tables, with data
    sql("CREATE TABLE portal_notifications (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL, kind TEXT NOT NULL,"
        " severity TEXT NOT NULL DEFAULT 'normal', title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',"
        " conversation_id BIGINT, alert_id BIGINT, email_to TEXT NOT NULL DEFAULT '',"
        " email_status TEXT NOT NULL DEFAULT 'off', email_error TEXT NOT NULL DEFAULT '',"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())", fetch=False)
    sql("CREATE TABLE portal_notify_settings (client_id BIGINT PRIMARY KEY, email_enabled BOOLEAN NOT NULL DEFAULT FALSE,"
        " email_to TEXT NOT NULL DEFAULT '', min_severity TEXT NOT NULL DEFAULT 'normal',"
        " kinds JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())", fetch=False)
    sql("INSERT INTO portal_notifications (client_id, kind, title, created_at)"
        " VALUES (7, 'system', 'old', NOW() - INTERVAL '3 days')", fetch=False)
    sql("INSERT INTO portal_notify_settings (client_id, email_enabled, email_to) VALUES (7, TRUE, 'owner@shop.pk')",
        fetch=False)
    pn._DDL_READY = False
    import portal_alerts
    portal_alerts._DDL_READY = False
    sent = []
    pn._deliver = lambda to, subj, text: sent.append((to, subj, text)) or (True, "")
    pn.EMAIL_ENABLED = True
    pn.EMAIL_SYNC = True

    def note(kind="escalation", title="Chat needs a human", severity="normal", client=7, **kw):
        return pn.notify(client, kind, title, kw.pop("detail", "Conversation #42"), severity=severity, **kw)

    first = note()
    check("db: old tables upgraded in place, old rows kept, email still sent",
          first["email"] == "sent" and first["in_app"] and sent[-1][1] == "[OmniFlow] Chat needs a human"
          and sql("SELECT title, in_app_status FROM portal_notifications WHERE id = 1")[0] == ("old", "")
          and sql("SELECT email_per_day FROM portal_notify_settings WHERE client_id = 7")[0][0] is None, first)
    check("db: ledger records the bell status", sql("SELECT in_app_status FROM portal_notifications"
                                                    " WHERE id = %s", (first["ledger_id"],))[0][0] == "shown")

    # --- email per kind per hour ------------------------------------------------
    sql("UPDATE portal_notify_settings SET email_per_hour = 2, bell_per_hour = 3 WHERE client_id = 7", fetch=False)
    second = note(title="Second")
    third = note(title="Third")
    check("db: 3rd email of a kind in an hour is held, the bell still rings",
          second["email"] == "sent" and third["email"] == "limited" and third["in_app"] and len(sent) == 2,
          (second, third))
    other_kind = note(kind="delivery", title="Delivery failed")
    check("db: the hourly cap is per kind", other_kind["email"] == "sent" and len(sent) == 3, other_kind)
    check("db: the next email that goes out says one was held back",
          sent[-1][2].endswith("1 more notification was held back by your email limits - see Settings >"
                               " Notifications."), sent[-1])
    urgent = note(title="Policy block", severity="high")
    check("db: high severity skips the hourly cap; held count reset after an email",
          urgent["email"] == "sent" and len(sent) == 4 and "held back" not in sent[-1][2], urgent)

    # --- bell per kind per hour ----------------------------------------------------
    fourth = note(title="Fourth")
    check("db: bell cap -> no alert, ledger says limited", fourth["in_app"] is None
          and sql("SELECT in_app_status FROM portal_notifications WHERE id = %s",
                  (fourth["ledger_id"],))[0][0] == "limited", fourth)
    held_more = note(kind="escalation", title="Fifth")
    urgent_bell = note(title="Urgent bell", severity="high")
    check("db: high severity skips the bell cap", urgent_bell["in_app"] is not None and held_more["email"] == "limited",
          (urgent_bell, held_more))
    check("db: held count adds up (two held since the last email)",
          sent[-1][2].endswith("2 more notifications were held back by your email limits - see Settings >"
                               " Notifications."), sent[-1])

    # --- held-back summary ---------------------------------------------------------
    sql("UPDATE portal_notifications SET created_at = created_at - INTERVAL '2 hours' WHERE client_id = 7",
        fetch=False)
    sent[:] = []
    after = note(title="Next hour")
    check("db: a new hour -> the kind emails again, nothing held", after["email"] == "sent"
          and "held back" not in sent[0][2], sent)

    # --- daily cap -----------------------------------------------------------------
    day = sql("SELECT COUNT(*) FROM portal_notifications WHERE client_id = 7"
              " AND email_status IN ('queued', 'sent', 'failed')")[0][0]
    sql("UPDATE portal_notify_settings SET email_per_day = %s WHERE client_id = 7", (day,), fetch=False)
    capped = note(kind="workflow", title="Run failed", severity="high")
    check("db: daily cap holds even for high severity", day == 6 and capped["email"] == "limited", (day, capped))
    tested = pn.notify(7, "system", "Test notification", "", email_sync=True, bypass_limits=True)
    check("db: Send a test skips every limit", tested["email"] == "sent", tested)
    sql("INSERT INTO portal_notify_settings (client_id, email_enabled, email_to, email_per_day)"
        " VALUES (8, TRUE, 'eight@shop.pk', 1)", fetch=False)
    other = note(client=8, title="Other shop")
    check("db: another workspace's ledger does not count", other["email"] == "sent", other)

    # --- HTTP ------------------------------------------------------------------------
    who = {"owner": {"client_id": 7, "role": "owner", "user_id": 1, "email": "o@shop.pk"},
           "agent": {"client_id": 7, "role": "agent", "user_id": 3},
           "key": {"client_id": 7, "role": "owner", "via_api_key": True},
           "eight": {"client_id": 8, "role": "owner", "user_id": 2}}
    current = {"p": who["owner"]}
    pn.authenticate_portal_request = lambda: current["p"]
    app = Flask("notify239")
    app.register_blueprint(pn.bp)
    client = app.test_client()
    base = "/api/v1/portal/notifications"

    def as_(name):
        current["p"] = who[name]
        return client

    r = as_("owner").put(base + "/templates/escalation",
                         json={"subject": "[Shop] {kind}: {title}", "body": "Salam!\n{detail}\n{link}"})
    body = r.get_json()
    esc = next(t for t in body["templates"] if t["kind"] == "escalation")
    check("http: owner saves a template", r.status_code == 200 and esc["custom"] and esc["updated_at"]
          and body["variables"][0]["key"] == "title" and body["can_edit"] is True
          and sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'notifications.template'")[0][0] == 1, body)
    sent[:] = []
    note(client=7, kind="escalation", title="Ali {detail}", detail="Wants a refund\n\n\n\nnow",
         conversation_id=9, severity="high", bypass_limits=True)
    check("http: real notifications use the template", sent and sent[0][1] == "[Shop] Handoffs: Ali {detail}"
          and sent[0][2] == "Salam!\nWants a refund\n\nnow\nOpen the conversation: /dashboard/conversations/9", sent)
    sent[:] = []
    pn.notify(8, "escalation", "Other shop chat", "", email_sync=True, bypass_limits=True)
    check("http: another workspace's emails keep the built-in template",
          sent and sent[0][1] == "[OmniFlow] Other shop chat", sent)
    r = as_("eight").get(base + "/templates")
    check("http: another workspace keeps the built-in email",
          not any(t["custom"] for t in r.get_json()["templates"]), r.get_json())
    for payload, why in (({"subject": "S {nope}", "body": "{title}"}, "unknown variable"),
                         ({"subject": "S", "body": "no variables"}, "no title / detail"),
                         ({"subject": "", "body": ""}, "blank")):
        r = as_("owner").put(base + "/templates/escalation", json=payload)
        check("http: 400 " + why, r.status_code == 400, r.get_json())
    r = as_("owner").put(base + "/templates/weather", json={"subject": "S", "body": "{title}"})
    check("http: unknown kind 404", r.status_code == 404)
    r = as_("agent").put(base + "/templates/escalation", json={"subject": "S", "body": "{title}"})
    check("http: agent cannot change templates", r.status_code == 403)
    r = as_("agent").get(base + "/templates")
    check("http: agent can read templates", r.status_code == 200 and r.get_json()["can_edit"] is False)
    r = as_("key").put(base + "/templates/escalation", json={"subject": "S", "body": "{title}"})
    check("http: API key refused", r.status_code == 403)
    r = as_("owner").post(base + "/templates/preview", json={"kind": "approval", "subject": "{kind}!",
                                                            "body": "{title}\n{link}"})
    check("http: preview renders sample values", r.status_code == 200 and r.get_json() == {
        "subject": "Approvals!", "body": "AI handed off a chat\nOpen the conversation: /dashboard/conversations/42"},
        r.get_json())
    r = as_("owner").post(base + "/templates/preview", json={"kind": "approval", "subject": "x", "body": "y"})
    check("http: preview validates", r.status_code == 400)
    r = as_("owner").delete(base + "/templates/escalation")
    check("http: reset to the built-in email", r.status_code == 200 and not any(
        t["custom"] for t in r.get_json()["templates"])
        and sql("SELECT COUNT(*) FROM portal_notify_templates")[0][0] == 0)

    r = as_("agent").put(base + "/settings", json={"email_per_day": 99})
    check("http: agent cannot change limits", r.status_code == 403
          and sql("SELECT email_per_day FROM portal_notify_settings WHERE client_id = 7")[0][0] == 6)
    r = as_("agent").put(base + "/settings", json={"kinds": {"knowledge": False}})
    check("http: agent can still change the rest", r.status_code == 200)
    r = as_("owner").put(base + "/settings", json={"email_per_day": 40, "email_per_hour": 9})
    check("http: owner sets limits; the default is stored as NULL", r.status_code == 200
          and r.get_json()["settings"]["email_per_hour"] == 9
          and sql("SELECT email_per_day, email_per_hour FROM portal_notify_settings WHERE client_id = 7")[0]
          == (None, 9), r.get_json())
    r = as_("owner").put(base + "/settings", json={"email_per_hour": 0})
    check("http: limit out of range 400", r.status_code == 400)
    r = as_("owner").get(base + "?limit=5")
    payload = r.get_json()
    check("http: list shows limits, max, edit right and bell status", r.status_code == 200
          and payload["limit_max"] == 500 and payload["can_edit"] is True
          and payload["settings"]["email_per_hour"] == 9 and "in_app_status" in payload["items"][0], payload)
    sent[:] = []
    sql("UPDATE portal_notify_settings SET email_per_day = 1 WHERE client_id = 7", fetch=False)
    r = as_("owner").post(base + "/test", json={"kind": "approval"})
    check("http: test sends the chosen kind", r.status_code == 200 and r.get_json()["result"]["email"] == "sent"
          and sql("SELECT kind FROM portal_notifications ORDER BY id DESC LIMIT 1")[0][0] == "approval")
    r = as_("owner").post(base + "/test", json={"kind": "weather"})
    check("http: test with an unknown kind 400", r.status_code == 400)
    r = as_("owner").post(base + "/test")
    check("http: test without a body = system", r.status_code == 200
          and sql("SELECT kind FROM portal_notifications ORDER BY id DESC LIMIT 1")[0][0] == "system")


database_half()
sys.exit(1 if summary("notify_templates") else 0)
