"""§242 proactive business alerts (portal_proactive + notify kind, event
catalog, workflow trigger, connector tick hook).

Units: rule registry, stored-settings shaping, strict validation (bools,
floats, text, ranges, unknown keys), asked-for phrases, the four detectors
(windows, distinct customers, bursts = one occasion, paused vs active
duplicates, mixed topics, spike baseline only over covered days), ordering,
read window, the tick throttle. HTTP guards (401 / 503 / 403 API key / 403
non-editor / 400 before any DB work / 503 without internals). Then the real
thing on pgserver: a fresh read creates nothing, one check raises each rule
from real rows (foreign workspace with the SAME product names and patterns
next to it), events + outbox rows + bell notifications, cooldown, re-raise
after the window, the every-N-minutes guard, off / busy (409), settings
save + audit, the repeat_complainer workflow trigger, a missing catalog.
"""
import json
import os
import sys
import tempfile
import threading

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in ("OF_PROACTIVE", "OF_PROACTIVE_EVERY_MINUTES", "OF_PROACTIVE_MAX_ALERTS",
             "OF_NOTIFY_ROLES", "OF_ALERTS"):
    os.environ.pop(name, None)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_proactive as pp  # noqa: E402
import portal_sales as ps  # noqa: E402
import portal_event_catalog as EC  # noqa: E402
import portal_notify  # noqa: E402
import portal_workflows  # noqa: E402
from portal_auth import PortalAuthUnavailable  # noqa: E402

HERE = os.getcwd()


def src(name):
    return open(os.path.join(HERE, name), encoding="utf8").read()


def item(ident, name, active=True):
    return {"id": ident, "name": name, "active": active,
            "_tokens": [t for t in ps._TOKEN_RE.findall(name.lower()) if t not in ps._STOP]}


def msg(conv, text, age):
    return {"conv": conv, "text": text, "age": age, "topics": pp._topics(text)}


print("== registry ==")
check("four rules", pp.RULE_KEYS == ("demand_unavailable", "repeat_complainer",
                                     "product_complaints", "complaint_spike"), pp.RULE_KEYS)
check("every rule: label, description, severity, params in range", all(
    spec["label"] and spec["description"] and spec["severity"] in ("normal", "high")
    and spec["params"] and all(low <= default <= high and label
                               for default, low, high, label in spec["params"].values())
    for spec in pp.RULES.values()))
check("windows never exceed the read cap", all(
    spec["params"]["window_hours"][2] <= pp.MAX_WINDOW_HOURS
    for spec in pp.RULES.values() if "window_hours" in spec["params"]))
check("labels plain text (no emoji)", all(ord(ch) < 0x2000 for spec in pp.RULES.values()
                                          for text in (spec["label"], spec["description"])
                                          for ch in text))
check("notify kind registered", "proactive" in portal_notify.KIND_KEYS
      and pp.NOTIFY_KIND == "proactive")
check("each rule is a catalog event in the alerts category", all(
    EC.category_of("proactive." + key) == "alerts" for key in pp.RULE_KEYS)
      and EC.CATEGORIES["alerts"] == "Business alerts")
import portal_webhooks as W  # noqa: E402
check("webhooks can subscribe to alerts", "alerts" in W.ALLOWED_EVENTS
      and all(W.EVENT_ACTIONS.get("proactive." + k) == "alerts" for k in pp.RULE_KEYS))
trig = portal_workflows.TRIGGERS["repeat_complainer"]
check("workflow trigger repeat_complainer reads the outbox event", trig["source"] == "log"
      and trig["actions"] == ["proactive.repeat_complainer"]
      and portal_workflows.validate_trigger("repeat_complainer", {})[0] == "repeat_complainer")
check("connector tick kicks proactive alerts in its own guard",
      "                    import portal_proactive\n" in src("connector_api.py")
      and "portal_proactive.kick(tenant[\"client_id\"])" in src("connector_api.py"))
check("every read is tenant-scoped (names: conversation ids are global, so pinned here)",
      "\" WHERE client_id = %s AND id = ANY(%s)\", (client_id, conv_ids))" in src("portal_proactive.py")
      and src("portal_proactive.py").count("WHERE client_id = %s") == 7)
check("app registers the blueprint", "aux_app.register_blueprint(portal_proactive_bp)" in src("app.py"))

print("== settings ==")
d = pp.default_rules()
check("defaults: every rule on with its defaults", all(d[k]["enabled"] is True for k in pp.RULE_KEYS)
      and d["demand_unavailable"] == {"enabled": True, "window_hours": 48, "min_customers": 3}
      and d["complaint_spike"] == {"enabled": True, "min_count": 5, "factor": 2}, d)
shaped = pp.shape_rules(json.dumps({
    "demand_unavailable": {"enabled": False, "window_hours": 24, "min_customers": True},
    "repeat_complainer": {"min_times": 99, "window_hours": "12", "enabled": "no"},
    "complaint_spike": {"factor": 3.0, "min_count": 9},
    "nope": {"enabled": False}, "product_complaints": "junk"}))
check("stored JSON shaped: good kept, bool/float/text/out-of-range -> default, unknown dropped",
      shaped["demand_unavailable"] == {"enabled": False, "window_hours": 24, "min_customers": 3}
      and shaped["repeat_complainer"] == {"enabled": True, "window_hours": 72, "min_times": 3}
      and shaped["complaint_spike"] == {"enabled": True, "min_count": 9, "factor": 2}
      and shaped["product_complaints"] == d["product_complaints"] and "nope" not in shaped, shaped)
check("whole numbers only (bool / float / text refused)", pp._whole(3) == 3 and pp._whole(True) is None
      and pp._whole(3.0) is None and pp._whole("3") is None)
check("junk stored value -> defaults", pp.shape_rules("not json") == d and pp.shape_rules(None) == d
      and pp.shape_rules([1]) == d)
current = {"enabled": True, "rules": pp.default_rules()}
merged, problem = pp.validate_settings(
    {"enabled": False, "rules": {"repeat_complainer": {"enabled": False, "min_times": 4},
                                 "complaint_spike": {"factor": 10}}}, current)
check("valid change merged", problem == "" and merged["enabled"] is False
      and merged["rules"]["repeat_complainer"] == {"enabled": False, "window_hours": 72, "min_times": 4}
      and merged["rules"]["complaint_spike"]["factor"] == 10
      and merged["rules"]["demand_unavailable"] == d["demand_unavailable"], merged)
check("current settings not mutated", current["rules"] == pp.default_rules() and current["enabled"] is True)
for bad in ([], {"enabled": "yes"}, {"enabled": 1}, {"rules": []}, {"rules": {"x": {}}},
            {"rules": {"complaint_spike": 5}}, {"rules": {"complaint_spike": {"enabled": "on"}}},
            {"rules": {"complaint_spike": {"speed": 1}}}, {"rules": {"complaint_spike": {"factor": 2.5}}},
            {"rules": {"complaint_spike": {"factor": True}}}, {"rules": {"complaint_spike": {"factor": "3"}}},
            {"rules": {"complaint_spike": {"factor": 1}}}, {"rules": {"complaint_spike": {"factor": 11}}},
            {"rules": {"demand_unavailable": {"window_hours": 169}}},
            {"rules": {"product_complaints": {"window_hours": 23}}}):
    out, why = pp.validate_settings(bad, current)
    check("refused " + json.dumps(bad), out is None and why, (out, why))
_out, why = pp.validate_settings({"rules": {"complaint_spike": {"factor": 1}}}, current)
check("refusal names the setting and its range",
      why == "Complaint spike: Times the usual daily number must be a whole number from 2 to 10.", why)
pub = pp.public_rules(pp.default_rules())
check("public rules carry params with ranges", [r["key"] for r in pub] == list(pp.RULE_KEYS)
      and pub[0]["params"][0] == {"key": "window_hours", "label": "Look back (hours)", "value": 48,
                                  "min": 6, "max": 168}, pub[0])

print("== phrases ==")
check("filler and digits dropped, pairs only of adjacent words",
      pp.phrases("Black abaya available hai?") == ["black", "black abaya", "abaya"]
      and pp.phrases("black hai abaya") == ["black", "abaya"]
      and pp.phrases("abaya2 size 40 hai") == []
      and pp.phrases("kya ye mil jayega") == [], pp.phrases("black hai abaya"))
check("3-letter words only inside a pair", pp.phrases("red top") == ["red top"]
      and pp.phrases("red hai") == [], pp.phrases("red top"))
check("long words are not cut into pieces", pp.phrases("a" * 25 + " shawl") == ["shawl"])

print("== demand ==")
cat = [item(1, "Lawn Suit Blue"), item(2, "Black Abaya", False), item(3, "Silk Dupatta"),
       item(4, "Silk Dupatta", False)]
P = {"window_hours": 48, "min_customers": 3}
asks = [msg(11, "Black abaya available hai?", 1), msg(12, "black abaya milegi?", 2),
        msg(13, "Abaya black wali stock me hai", 3)]
out = pp.detect_demand(asks, cat, P)
check("3 customers ask for a paused product -> alert", [o["subject"] for o in out] == ["item:2"]
      and out[0]["title"] == "3 customers asked for Black Abaya (paused in your catalog)"
      and out[0]["count"] == 3 and out[0]["conversation_id"] is None, out)
check("same customer three times = one customer", pp.detect_demand(
    [msg(11, "black abaya available?", a) for a in (1, 2, 3)], cat, P) == [])
check("2 customers is below the minimum", pp.detect_demand(asks[:2], cat, P) == [])
check("asks older than the window are ignored", pp.detect_demand(
    asks[:2] + [msg(13, "black abaya available?", 49)], cat, P) == [])
check("a product that is ALSO listed as active is never 'paused'", pp.detect_demand(
    [msg(c, "silk dupatta available hai?", 1) for c in (21, 22, 23)], cat, P) == [])
check("naming an active product skips the message", pp.detect_demand(
    [msg(c, "lawn suit blue ya black abaya available?", 1) for c in (21, 22, 23)], cat, P) == [])
unl = [msg(31, "chiffon saree available hai", 1), msg(32, "chiffon saree milegi?", 2),
       msg(33, "Chiffon saree hai kya", 3), msg(34, "chiffon saree price?", 4)]
out = pp.detect_demand(unl, cat, P)
check("unlisted: one alert for the most specific phrase", [o["subject"] for o in out]
      == ["ask:chiffon saree"] and out[0]["count"] == 4
      and out[0]["title"] == "4 customers asked for \"chiffon saree\" - not in your catalog", out)
mixed = [msg(c, "chiffon saree delivery kab tak available", 1) for c in (41, 42, 43)]
check("messages about delivery etc. are not product asks", pp.detect_demand(mixed, cat, P) == [],
      [m["topics"] for m in mixed])
check("no catalog -> nothing is paused or unlisted", pp.detect_demand(unl, [], P) == [])
many = []
for n, word in enumerate(("velvet", "pashmina", "kurta", "lehnga", "gharara")):
    many += [msg(100 + n * 10 + c, word + " available hai?", 1) for c in range(3)]
out = pp.detect_demand(many, cat, P)
check("at most MAX_PHRASES unlisted phrases per check", len(out) == pp.MAX_PHRASES == 3, out)

print("== repeat complainer ==")
R = {"window_hours": 72, "min_times": 3}
three = [msg(7, "order abhi tak nahi aya", 50), msg(7, "complaint: still not received", 20),
         msg(7, "refund chahiye, kharab item", 2)]
out = pp.detect_repeat(three, R)
check("3 separate complaints -> alert with the chat link", len(out) == 1
      and out[0]["subject"] == "conv:7" and out[0]["conversation_id"] == 7
      and out[0]["href"] == "/dashboard/conversations/7"
      and out[0]["title"] == "A customer complained 3 separate times in 72 hours", out)
burst = [msg(8, "complaint", 5 + i / 60.0) for i in range(5)]
check("a burst of lines within 30 minutes is ONE occasion", pp.detect_repeat(burst, R) == [])
spread = [msg(8, "complaint", 5.0), msg(8, "complaint", 5.0 - 31 / 60.0), msg(8, "complaint", 4.0 - 2 / 60.0)]
check("31 minutes apart counts again", len(pp.detect_repeat(spread, R)) == 1)
check("outside the window ignored", pp.detect_repeat(three[:2] + [msg(7, "complaint", 80)], R) == [])
check("non-complaint messages ignored", pp.detect_repeat(
    [msg(9, "price kya hai", a) for a in (1, 10, 20)], R) == [])

print("== product complaints ==")
C = {"window_hours": 168, "min_customers": 3}
pc = [msg(51, "lawn suit blue ka colour kharab nikla", 10), msg(52, "Lawn suit blue wrong item aya", 30),
      msg(53, "lawn suit blue complaint", 100), msg(54, "lawn suit blue price?", 5)]
out = pp.detect_product_complaints(pc, cat, C)
check("3 customers complain about one product -> alert", [o["subject"] for o in out] == ["item:1"]
      and out[0]["title"] == "3 customers complained about Lawn Suit Blue" and out[0]["count"] == 3, out)
check("questions about the product are not complaints", pp.detect_product_complaints(
    [msg(c, "lawn suit blue price?", 1) for c in (61, 62, 63)], cat, C) == [])
check("paused products count too", len(pp.detect_product_complaints(
    [msg(c, "black abaya kharab hai", 1) for c in (61, 62, 63)], cat, C)) == 1)

print("== spike ==")
S = {"min_count": 5, "factor": 2}
base = [msg(200 + i, "complaint", 24 + i * 24 + 1) for i in range(7)]  # 1/day for 7 days
today = [msg(300 + i, "complaint", 1 + i) for i in range(5)]
out = pp.detect_spike(base + today, S, 24 * 8)
check("5 today vs 1 a day -> spike", len(out) == 1 and out[0]["count"] == 5
      and out[0]["data"] == {"today": 5, "usual_per_day": 1.0, "baseline_days": 7}
      and out[0]["detail"].startswith("Usually about 1 a day (last 7 days)."), out)
check("below min_count -> nothing", pp.detect_spike(base + today[:4], S, 24 * 8) == [])
busy = [msg(400 + i, "complaint", 24 + (i % 7) * 24 + 1) for i in range(21)]  # 3/day
check("5 today vs 3 a day is not 2x -> nothing", pp.detect_spike(busy + today, S, 24 * 8) == [])
check("6 today vs 3 a day is 2x -> spike", len(pp.detect_spike(
    busy + today + [msg(999, "complaint", 0.5)], S, 24 * 8)) == 1)
check("fewer than 3 covered days -> never a spike", pp.detect_spike(today, S, 24 + 47) == []
      and len(pp.detect_spike(today, S, 24 + 72)) == 1)
quiet = {"min_count": 2, "factor": 3}
check("a quiet week still needs factor x 1 (2 today, factor 3 -> nothing; 3 -> spike)",
      pp.detect_spike(today[:2], quiet, 24 * 5) == [] and len(pp.detect_spike(today[:3], quiet, 24 * 5)) == 1)
odd = [msg(500 + i, "complaint", 25 + i * 24) for i in range(3)]
check("usual shown with one decimal", pp.detect_spike(odd + today * 2, S, 24 + 96 + 1)[0]["detail"]
      .startswith("Usually about 0.8 a day (last 4 days)."))

print("== evaluate ==")
settings = {"enabled": True, "rules": pp.default_rules()}
every = asks + three + pc + base + today
out = pp.evaluate(settings, every, cat, 24 * 8)
check("high severity first, cooldown = the rule's window (spike 24h)",
      [o["rule"] for o in out][:2] == ["complaint_spike", "product_complaints"]
      and all(o["severity"] == pp.RULES[o["rule"]]["severity"] for o in out)
      and {o["rule"]: o["cooldown_hours"] for o in out}
      == {"complaint_spike": 24, "product_complaints": 168, "demand_unavailable": 48,
          "repeat_complainer": 72}, [(o["rule"], o["cooldown_hours"]) for o in out])
settings["rules"]["complaint_spike"]["enabled"] = False
settings["rules"]["demand_unavailable"]["enabled"] = False
check("disabled rules do not run", {o["rule"] for o in pp.evaluate(settings, every, cat, 24 * 8)}
      == {"product_complaints", "repeat_complainer"})
check("read window = longest enabled window (spike needs 8 days)",
      pp.fetch_hours({"rules": pp.default_rules()}) == 192 and pp.fetch_hours(settings) == 168)
for key in pp.RULE_KEYS:
    settings["rules"][key]["enabled"] = False
check("everything off -> nothing read", pp.fetch_hours(settings) == 0)

print("== tick throttle ==")
started = []
real_thread = pp.threading.Thread


class FakeThread:
    def __init__(self, target, args, name, daemon):
        started.append(args[0])

    def start(self):
        pass


pp.threading.Thread = FakeThread
pp._LAST.clear()
pp._RUNNING.clear()
check("first kick starts, a second within the interval does not",
      pp.kick(7) is True and pp.kick(7) is False and started == [7])
pp._RUNNING.discard(7)
check("still throttled after the job ended", pp.kick("7") is False)
check("bad ids refused", pp.kick(0) is False and pp.kick("x") is False and pp.kick(None) is False)
pp._LAST[7] = -1e18
check("after the interval it starts again", pp.kick(7) is True and started == [7, 7])
pp.ENABLED = False
pp._LAST.clear()
pp._RUNNING.clear()
check("OF_PROACTIVE=0: the tick does nothing", pp.kick(9) is False and started == [7, 7])
check("OF_PROACTIVE=0: a run does nothing", pp.run(9)["reason"] == "off")
pp.ENABLED = True
pp.threading.Thread = real_thread
pp._RUNNING.clear()
pp._LAST.clear()

print("== HTTP guards (no database touched) ==")
app = Flask(__name__)
app.register_blueprint(pp.bp)
client = app.test_client()
URL = "/api/v1/portal/proactive"
current_p = {"p": None, "exc": None}


def fake_auth():
    if current_p["exc"]:
        raise current_p["exc"]
    return current_p["p"]


pp.authenticate_portal_request = fake_auth
db_calls = []
real_conn = portal_db._conn
portal_db._conn = lambda: db_calls.append(1) or (_ for _ in ()).throw(RuntimeError("db down"))
owner = {"client_id": 7, "user_id": 1, "role": "owner", "via_api_key": False}
check("no session -> 401", client.get(URL).status_code == 401 and client.put(URL, json={}).status_code == 401
      and client.post(URL + "/run").status_code == 401)
current_p["exc"] = PortalAuthUnavailable("auth down")
check("auth unavailable -> 503", client.get(URL).status_code == 503)
current_p["exc"] = None
current_p["p"] = dict(owner, via_api_key=True)
check("API key -> 403 everywhere", client.get(URL).status_code == 403
      and client.put(URL, json={}).status_code == 403 and client.post(URL + "/run").status_code == 403)
current_p["p"] = dict(owner, role="agent")
r = client.put(URL, json={"enabled": False})
check("non-editor PUT -> 403 forbidden", r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden")
current_p["p"] = owner
r = client.put(URL, data="nope", content_type="application/json")
check("PUT without a JSON object -> 400", r.status_code == 400 and r.get_json()["error"]["code"] == "bad_request")
check("refused requests never reach the database", not db_calls)
for method, url in (("get", URL), ("put", URL), ("post", URL + "/run")):
    response = getattr(client, method)(url, json={"enabled": True})
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
    data = tempfile.mkdtemp(prefix="proactive242_")
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

    def tables():
        return sql("SELECT to_regclass('portal_proactive_settings'), to_regclass('portal_proactive_events')")[0]

    code_body = client.get(URL)
    fresh = code_body.get_json()
    check("fresh db: GET 200 with defaults and no history", code_body.status_code == 200
          and fresh["enabled"] is True and fresh["recent"] == [] and fresh["last_run_at"] is None
          and fresh["can_edit"] is True and fresh["available"] is True
          and [r["key"] for r in fresh["rules"]] == list(pp.RULE_KEYS), fresh)
    check("fresh db: reading creates nothing", tables() == (None, None))

    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)
    import portal_catalog
    c = portal_db._conn()
    portal_catalog._ensure_catalog_tables(c)
    c.commit()
    c.close()

    def conv(client_id, contact, name):
        return sql("INSERT INTO portal_conversations (client_id, channel, contact_id, contact_name)"
                   " VALUES (%s, 'whatsapp', %s, %s) RETURNING id", (client_id, contact, name))[0][0]

    def say(client_id, conv_id, body, hours):
        sql("INSERT INTO portal_messages (conversation_id, client_id, direction, body, created_at)"
            " VALUES (%s, %s, 'in', %s, NOW() - (%s * INTERVAL '1 hour'))",
            (conv_id, client_id, body, hours), fetch=False)

    def product(client_id, name, active=True):
        return sql("INSERT INTO portal_catalog (client_id, name, is_active) VALUES (%s, %s, %s)"
                   " RETURNING id", (client_id, name, active))[0][0]

    abaya = product(7, "Black Abaya", False)
    lawn = product(7, "Lawn Suit Blue")
    for client_id in (7, 8):
        if client_id == 8:
            product(8, "Black Abaya", False)
            product(8, "Lawn Suit Blue")
        convs = [conv(client_id, "c%d_%d" % (client_id, i), "Cust %d-%d" % (client_id, i)) for i in range(12)]
        # paused product asked by 3 customers (workspace 8: only 2)
        for i in range(3 if client_id == 7 else 2):
            say(client_id, convs[i], "Black abaya available hai?", 1 + i)
        # unlisted product asked by 3 customers
        for i in range(3, 6 if client_id == 7 else 5):
            say(client_id, convs[i], "chiffon saree milegi?", 2)
        # one customer complains on 3 separate occasions
        for hours in ((50, 20, 2) if client_id == 7 else (50, 20)):
            say(client_id, convs[6], "order abhi tak nahi aya, complaint", hours)
        # product complaints from 3 customers (incl. the repeat complainer's chat)
        for i in (7, 8, 9) if client_id == 7 else (7, 8):
            say(client_id, convs[i], "lawn suit blue kharab nikla", 30)
        # complaint baseline: one a day for 7 days, then a spike today
        for day in range(7):
            say(client_id, convs[10], "complaint", 24 + day * 24 + 3)
        # spike: 6 more customers complain today (+ the repeat complainer's 2 = 8)
        for i in range(6 if client_id == 7 else 1):
            say(client_id, conv(client_id, "s%d_%d" % (client_id, i), "S"), "complaint", 3 + i)
        if client_id == 7:
            c7 = convs
    # 1: outbound replies never count as customer demand / complaints
    for i in (7, 8, 9, 10):
        say_out = c7[i]
        sql("INSERT INTO portal_messages (conversation_id, client_id, direction, body, created_at)"
            " VALUES (%s, 7, 'out', 'lawn suit blue complaint noted, black abaya available hai?',"
            " NOW() - INTERVAL '1 hour')", (say_out,), fetch=False)
    # 3: a foreign workspace's recent alert on the same rule + subject
    c = portal_db._conn()
    with c.cursor() as cur:
        pp._ensure_ddl(cur)
    c.commit()
    c.close()
    sql("INSERT INTO portal_proactive_events (client_id, rule, subject, title)"
        " VALUES (8, 'complaint_spike', 'all', 'foreign')", fetch=False)
    r = client.post(URL + "/run")
    body = r.get_json()
    rules = sorted(a["rule"] for a in body["alerts"])
    check("one check raises every rule from real rows", r.status_code == 200 and rules == sorted(
        ["complaint_spike", "product_complaints", "demand_unavailable", "demand_unavailable",
         "repeat_complainer"]) and body["checked"] > 0, body)
    titles = {a["title"] for a in body["alerts"]}
    check("titles name the product / phrase / contact (never message text)", titles == {
        "Complaints spiked: 8 in the last 24 hours",
        "3 customers complained about Lawn Suit Blue",
        "3 customers asked for Black Abaya (paused in your catalog)",
        "3 customers asked for \"chiffon saree\" - not in your catalog",
        "Cust 7-6 complained 3 separate times in 72 hours"}, titles)
    check("workspace 7 counts only its own rows (8 has the same products / patterns)",
          sql("SELECT title FROM portal_proactive_events WHERE client_id = 8") == [("foreign",)])
    sql("DELETE FROM portal_proactive_events WHERE client_id = 8", fetch=False)
    rep = next(a for a in body["alerts"] if a["rule"] == "repeat_complainer")
    check("repeat alert links its chat", rep["conversation_id"] == c7[6]
          and rep["href"] == "/dashboard/conversations/" + str(c7[6]) and rep["severity"] == "normal")
    spike = next(a for a in body["alerts"] if a["rule"] == "complaint_spike")
    check("spike: 8 today vs 10 over the 6 covered days before", spike["detail"].startswith(
        "Usually about 1.7 a day (last 6 days).") and spike["severity"] == "high", spike)
    stored = sql("SELECT rule, subject, data FROM portal_proactive_events WHERE client_id = 7 ORDER BY rule, subject")
    check("events stored with subjects", [(s[0], s[1]) for s in stored] == [
        ("complaint_spike", "all"), ("demand_unavailable", "ask:chiffon saree"),
        ("demand_unavailable", "item:" + str(abaya)), ("product_complaints", "item:" + str(lawn)),
        ("repeat_complainer", "conv:" + str(c7[6]))], stored)
    logs = sql("SELECT action, actor_kind, conversation_id FROM portal_action_log WHERE client_id = 7"
               " AND action LIKE 'proactive.%%' ORDER BY action, id")
    check("each alert is an outbox event (webhooks + workflows)", [x[0] for x in logs] == sorted(
        "proactive." + a["rule"] for a in body["alerts"]) and all(x[1] == "system" for x in logs)
          and (("proactive.repeat_complainer", "system", c7[6]) in logs), logs)
    bell = sql("SELECT kind, severity, title FROM portal_alerts WHERE client_id = 7 ORDER BY id")
    ledger = sql("SELECT kind, conversation_id FROM portal_notifications WHERE client_id = 7")
    check("bell + notification ledger got every alert as kind 'proactive'", len(bell) == 5
          and all(b[0] == "proactive" for b in bell) and {b[2] for b in bell} == titles
          and len(ledger) == 5 and all(x[0] == "proactive" for x in ledger)
          and (("proactive", c7[6]) in ledger), (bell, ledger))
    check("high severity reaches the bell as high", {b[2]: b[1] for b in bell}[
        "Complaints spiked: 8 in the last 24 hours"] == "high")
    check("last_run_at recorded", sql("SELECT last_run_at IS NOT NULL FROM portal_proactive_settings"
                                      " WHERE client_id = 7")[0][0] is True)

    sql("UPDATE portal_proactive_events SET created_at = created_at - INTERVAL '2 hours'", fetch=False)
    again = client.post(URL + "/run").get_json()
    check("second check 2 hours later: nothing new (cooldown in hours per rule + subject)", again["alerts"] == []
          and sql("SELECT COUNT(*) FROM portal_proactive_events")[0][0] == 5, again)
    sql("UPDATE portal_proactive_events SET created_at = created_at - INTERVAL '73 hours'"
        " WHERE rule = 'repeat_complainer'", fetch=False)
    say(7, c7[6], "refund chahiye, complaint", 0.5)
    sql("UPDATE portal_alerts SET is_read = TRUE WHERE client_id = 7", fetch=False)
    before_run = sql("SELECT last_run_at FROM portal_proactive_settings WHERE client_id = 7")[0][0]
    third = client.post(URL + "/run").get_json()
    check("every check moves last_run_at forward", sql(
        "SELECT last_run_at FROM portal_proactive_settings WHERE client_id = 7")[0][0] > before_run)
    check("after the window the same subject can alert again", [a["rule"] for a in third["alerts"]]
          == ["repeat_complainer"], third)

    sql("UPDATE portal_proactive_settings SET last_run_at = NOW() - INTERVAL '5 minutes'", fetch=False)
    res = pp.run(7)
    check("automatic run within OF_PROACTIVE_EVERY_MINUTES (5 of 30 minutes) is skipped", res["ran"] is False
          and res["reason"] == "recent", res)
    sql("UPDATE portal_proactive_settings SET last_run_at = NOW() - INTERVAL '31 minutes'", fetch=False)
    res = pp.run(7)
    check("automatic run after the interval runs", res["ran"] is True and res["alerts"] == [], res)

    got = client.get(URL).get_json()
    check("GET shows history newest first with rule labels", len(got["recent"]) == 6
          and got["recent"][0]["rule"] == "repeat_complainer"
          and got["recent"][0]["rule_label"] == "Customer complaining repeatedly"
          and got["last_run_at"], got["recent"][:1])
    current_p["p"] = dict(owner, client_id=8)
    check("history is per workspace", client.get(URL).get_json()["recent"] == [])
    current_p["p"] = owner

    # --- settings ---
    r = client.put(URL, json={"rules": {"complaint_spike": {"factor": 1}}})
    check("PUT out of range -> 400 with the reason", r.status_code == 400
          and "from 2 to 10" in r.get_json()["error"]["message"])
    r = client.put(URL, json={"enabled": True, "rules": {"demand_unavailable": {"enabled": False},
                                                         "repeat_complainer": {"min_times": 5}}})
    saved = r.get_json()
    rules_by = {x["key"]: x for x in saved["rules"]}
    check("PUT saves and returns the new settings", r.status_code == 200 and saved["ok"] is True
          and rules_by["demand_unavailable"]["enabled"] is False
          and rules_by["repeat_complainer"]["params"][1]["value"] == 5, saved)
    check("save is audited", sql("SELECT note FROM portal_action_log WHERE action = 'proactive_settings.saved'")
          == [("On; rules on: Customer complaining repeatedly, Complaints about one product, Complaint spike",)])
    current_p["p"] = dict(owner, role="agent", user_id=9)
    check("teammates can read and run a check but not save",
          client.get(URL).status_code == 200 and client.post(URL + "/run").status_code == 200
          and client.put(URL, json={"enabled": False}).status_code == 403)
    current_p["p"] = owner
    client.put(URL, json={"enabled": False})
    r = client.post(URL + "/run")
    check("turned off -> Check now 409 disabled", r.status_code == 409
          and r.get_json()["error"]["code"] == "disabled")
    check("turned off -> automatic run does nothing", pp.run(7)["reason"] == "disabled")
    client.put(URL, json={"enabled": True})

    holder = psycopg2.connect(host=data, dbname="postgres", user="postgres")
    hc = holder.cursor()
    hc.execute("BEGIN; SELECT pg_advisory_xact_lock(%s, %s)", (pp.LOCK_CLASS, 7))
    r = client.post(URL + "/run")
    check("a check already running -> 409 busy", r.status_code == 409 and r.get_json()["error"]["code"] == "busy")
    holder.rollback()
    holder.close()

    # --- workflow trigger on the outbox event ---
    c = portal_db._conn()
    with c.cursor() as cur:
        portal_workflows._ensure_ddl(cur)
    c.commit()
    c.close()
    wf = sql("INSERT INTO portal_workflows (client_id, name, status, trigger_type, trigger_config)"
             " VALUES (7, 'Say sorry', 'active', 'repeat_complainer', '{}'::jsonb) RETURNING id")[0][0]
    sql("INSERT INTO portal_workflows (client_id, name, status, trigger_type, trigger_config)"
        " VALUES (8, 'Foreign', 'active', 'repeat_complainer', '{}'::jsonb)", fetch=False)
    c = portal_db._conn()
    with c.cursor() as cur:
        started = portal_workflows.trigger_log_events(cur, 7)
        foreign = portal_workflows.trigger_log_events(cur, 8)
    c.commit()
    c.close()
    runs = sql("SELECT workflow_id, event, conversation_id, contact_name FROM portal_workflow_runs ORDER BY id")
    check("repeat_complainer starts the workflow for that customer (once per event)",
          started == 2 and foreign == 0 and runs == [(wf, "repeat_complainer", c7[6], "Cust 7-6")] * 2, runs)

    # --- first ever run that ends busy: the tables it created must stay ---
    sql("DROP TABLE portal_proactive_events, portal_proactive_settings", fetch=False)
    pp._DDL_READY = False
    holder = psycopg2.connect(host=data, dbname="postgres", user="postgres")
    hc = holder.cursor()
    hc.execute("BEGIN; SELECT pg_advisory_xact_lock(%s, %s)", (pp.LOCK_CLASS, 7))
    first = client.post(URL + "/run")
    holder.rollback()
    holder.close()
    check("busy first run keeps the tables it created", first.status_code == 409
          and tables() == ("portal_proactive_settings", "portal_proactive_events"), tables())
    check("the next check works", client.post(URL + "/run").status_code == 200)

    # --- missing catalog: other rules still work ---
    client.put(URL, json={"rules": {"repeat_complainer": {"min_times": 3}}})
    sql("ALTER TABLE portal_catalog RENAME TO portal_catalog_off", fetch=False)
    sql("ALTER TABLE portal_action_log RENAME TO portal_action_log_off", fetch=False)
    sql("DELETE FROM portal_proactive_events", fetch=False)
    sql("UPDATE portal_alerts SET is_read = TRUE", fetch=False)
    out = client.post(URL + "/run").get_json()
    check("no catalog / no outbox table: complaint rules still alert, product rules skip",
          sorted(a["rule"] for a in out["alerts"]) == ["complaint_spike", "repeat_complainer"]
          and sql("SELECT COUNT(*) FROM portal_proactive_events")[0][0] == 2, out)
    sql("ALTER TABLE portal_catalog_off RENAME TO portal_catalog", fetch=False)
    sql("ALTER TABLE portal_action_log_off RENAME TO portal_action_log", fetch=False)


run_db()
summary("proactive")
