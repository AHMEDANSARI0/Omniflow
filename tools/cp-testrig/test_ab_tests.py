"""§234 Broadcast A/B tests - versions, a random test slice, measured winner.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
Units for the statistics (one-sided two-proportion z-test, the decision
rules and their honest "not yet" reasons), the split and the balanced
deterministic assignment, input validation; then the real thing on
`pgserver`: a test is sent through the broadcast engine (commands,
personalisation, opt-outs, per-version broadcast rows, assignments, audit),
replies / paid orders are attributed only inside each customer's window,
delivery counts, the manual winner goes to the rest (fresh audience,
tested + opted-out customers excluded), cancel, the plan limit (also when
the plan table is missing), the running cap, tenant isolation, auth, and
the automatic winner slot on the existing broadcast scheduler: clear
winner sent, unclear skipped + owner notified, a cancelled slot, a stale
slot, and a failing engine that cannot break other scheduled sends.
Web pins at the end.
"""
import os
import re
import sys

from test_lib import check, summary

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in list(os.environ):
    if name.startswith("OF_AB_"):
        os.environ.pop(name)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))

import portal_db  # noqa: E402
import portal_growth  # noqa: E402
import portal_plans  # noqa: E402
import portal_ab_tests as ab  # noqa: E402

# ---------------------------------------------------------------------------
print("== statistics ==")
check("z-test: equal rates -> 50%", abs(ab.confidence(10, 50, 10, 50) - 0.5) < 1e-9)
check("z-test: 30/100 vs 10/100 -> above 99.9%", ab.confidence(30, 100, 10, 100) > 0.999)
check("z-test: the worse side gets the mirror value",
      abs(ab.confidence(10, 100, 30, 100) + ab.confidence(30, 100, 10, 100) - 1.0) < 1e-9)
check("z-test: empty group or no variance -> None",
      ab.confidence(0, 0, 1, 10) is None and ab.confidence(0, 10, 0, 10) is None
      and ab.confidence(10, 10, 10, 10) is None)
check("defaults: min 20 per version, 5 outcomes, 95% confidence, 3 versions",
      (ab.MIN_PER_VARIANT, ab.MIN_OUTCOMES, ab.CONFIDENCE, ab.MAX_VARIANTS) == (20, 5, 95, 3))


def V(label, sent, replied=0, ordered=0):
    return {"label": label, "sent": sent, "replied": replied, "ordered": ordered}


got = ab.decide([V("A", 50, 25), V("B", 50, 5)], "reply")
check("decide: clear winner with confidence and a plain reason",
      got["clear"] and got["winner"] == "A" and got["confidence"] > 99
      and got["reason"].startswith("Version A wins on replies"), got)
got = ab.decide([V("A", 10, 9), V("B", 10, 0)], "reply")
check("decide: too few customers per version -> no winner, leader still shown",
      not got["clear"] and got["winner"] is None and got["leader"] == "A"
      and "at least 20 (smallest got 10)" in got["reason"], got)
got = ab.decide([V("A", 50, 2), V("B", 50, 1)], "reply")
check("decide: too few outcomes -> says how many", not got["clear"]
      and "Too few replies so far to compare (3 of at least 5)" in got["reason"], got)
got = ab.decide([V("A", 50, 10), V("B", 50, 10)], "reply")
check("decide: tie -> no leader", got["leader"] is None and got["reason"] == "The versions are tied.", got)
got = ab.decide([V("A", 50, 14), V("B", 50, 10)], "reply")
check("decide: leader but not clear -> confidence and the bar it misses",
      not got["clear"] and got["leader"] == "A" and 50 < got["confidence"] < 95
      and "leads, but not clearly yet" in got["reason"] and "95% needed" in got["reason"], got)
got = ab.decide([V("A", 50, 30), V("B", 50, 5), V("C", 50, 22)], "reply")
check("decide: 3 versions -> the leader must beat EVERY other one (weakest pair counts)",
      not got["clear"] and got["leader"] == "A"
      and got["confidence"] == round(ab.confidence(30, 50, 22, 50) * 100, 1), got)
got = ab.decide([V("A", 50, 40, 2), V("B", 50, 10, 12)], "order")
check("decide: order metric uses paid orders, not replies",
      got["clear"] and got["winner"] == "B" and "paid orders" in got["reason"], got)
got = ab.decide([V("A", 50, 5), V("B", 0)], "reply")
check("decide: an unsent version -> not comparable", not got["clear"]
      and got["reason"] == "Not every version has been sent yet.", got)

print("== split / assignment ==")
check("split: 30% of 100 -> 30 tested, 70 rest", ab.split(100, 30, 2) == (30, 70))
check("split: rounds up and keeps one customer per version",
      ab.split(5, 10, 2) == (2, 3) and ab.split(7, 30, 3) == (3, 4))
check("split: never more than the audience; 100% -> no rest",
      ab.split(3, 10, 3) == (3, 0) and ab.split(10, 100, 2) == (10, 0))
people = ["c%02d" % i for i in range(30)]
pairs = ab.assign(people, ["A", "B", "C"], "7:1")
check("assign: everyone once, balanced round-robin",
      sorted(c for c, _ in pairs) == people
      and [sum(1 for _, v in pairs if v == L) for L in "ABC"] == [10, 10, 10])
check("assign: deterministic per seed, shuffled across seeds",
      ab.assign(people, ["A", "B"], "7:1") == ab.assign(people, ["A", "B"], "7:1")
      and ab.assign(people, ["A", "B"], "7:1") != ab.assign(people, ["A", "B"], "7:2")
      and [c for c, _ in pairs] != people)

print("== validation ==")


def bad(payload, fragment):
    try:
        ab.validate(payload)
    except ab.TestError as exc:
        return fragment in str(exc)
    return False


ok = ab.validate({"variants": ["Hi {name}", "Salam {name}"]})
check("validate: defaults (all, reply, 30%, 24h, manual)",
      ok == {"variants": ["Hi {name}", "Salam {name}"], "audience": "all", "metric": "reply",
             "test_percent": 30, "decide_hours": 24, "auto_winner": False, "name": ""}, ok)
check("validate: versions as objects, segment audience, strings for numbers",
      ab.validate({"variants": [{"body": " a "}, {"body": "b"}], "audience": "Segment:4",
                   "test_percent": "50", "decide_hours": 6, "metric": "order"})
      == {"variants": ["a", "b"], "audience": "segment:4", "metric": "order",
          "test_percent": 50, "decide_hours": 6, "auto_winner": False, "name": ""})
check("validate: auto winner kept below 100%, dropped at 100% (no rest)",
      ab.validate({"variants": ["a", "b"], "auto_winner": True})["auto_winner"] is True
      and ab.validate({"variants": ["a", "b"], "auto_winner": True,
                       "test_percent": 100})["auto_winner"] is False)
check("validate: name collapsed and capped at 80",
      ab.validate({"variants": ["a", "b"], "name": "  Eid   sale " + "x" * 200})["name"]
      == ("Eid sale " + "x" * 200)[:80])
check("validate: rejects non-objects, 1 version and more than the max",
      bad([], "JSON object") and bad({"variants": ["a"]}, "2 to 3")
      and bad({"variants": ["a", "b", "c", "d"]}, "2 to 3"))
check("validate: empty, too long and duplicate (case / spacing) versions",
      bad({"variants": ["a", " "]}, "needs message text")
      and bad({"variants": ["a", "x" * 1001]}, "1000 characters")
      and bad({"variants": ["Hi  there", "hi there"]}, "different"))
check("validate: audience and metric",
      bad({"variants": ["a", "b"], "audience": "vip"}, "audience must be")
      and bad({"variants": ["a", "b"], "audience": "segment:x"}, "audience must be")
      and bad({"variants": ["a", "b"], "metric": "clicks"}, "reply or order"))
check("validate: test share and decision hours bounds / types",
      bad({"variants": ["a", "b"], "test_percent": 5}, "between 10 and 100")
      and bad({"variants": ["a", "b"], "test_percent": 101}, "between 10 and 100")
      and bad({"variants": ["a", "b"], "test_percent": 30.5}, "whole number")
      and bad({"variants": ["a", "b"], "test_percent": True}, "whole number")
      and bad({"variants": ["a", "b"], "test_percent": "abc"}, "whole number")
      and bad({"variants": ["a", "b"], "decide_hours": 0}, "between 1 and 168")
      and bad({"variants": ["a", "b"], "decide_hours": 169}, "between 1 and 168")
      and bad({"variants": ["a", "b"], "auto_winner": "yes"}, "true or false"))


# ---------------------------------------------------------------------------
def db_half():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    import tempfile
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="ab234_")
    server = pgserver.get_server(data, cleanup_mode="stop")
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()

    def connect():
        return psycopg2.connect(host=data, dbname="postgres", user="postgres")

    def sql(q, a=(), fetch=True):
        c = connect()
        try:
            cur = c.cursor()
            cur.execute(q, a)
            got = cur.fetchall() if fetch and cur.description else None
            c.commit()
            return got
        finally:
            c.close()

    import portal_checkout
    c = connect()
    portal_checkout._ensure_checkout_tables(c)
    c.commit()
    c.close()
    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)
    # workspace 7: 61 customers (c001..c061), c061 opted out; 3 hot leads.
    for i in range(1, 62):
        sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name, status)"
            " VALUES (7, %s, %s, 'open')", ("c%03d" % i, "Ali%d Khan" % i), fetch=False)
    sql("ALTER TABLE portal_conversations ADD COLUMN IF NOT EXISTS lead_temp TEXT", fetch=False)
    sql("UPDATE portal_conversations SET lead_temp = 'hot' WHERE client_id = 7"
        " AND contact_id IN ('c001', 'c002', 'c003')", fetch=False)
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (7, 'c061')", fetch=False)
    # workspace 8 shares a contact id with 7 (same phone, other business).
    for i in range(1, 6):
        sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name)"
            " VALUES (8, %s, 'Other')", ("c%03d" % i,), fetch=False)

    from flask import Flask, jsonify
    app = Flask("ab234")
    app.register_blueprint(ab.bp)
    who = {"client_id": 7, "user_id": 5, "email": "o@x.pk", "role": "owner"}
    real_auth = ab.authenticate_portal_request
    ab.authenticate_portal_request = lambda: dict(who)
    import portal_notify
    real_notify = portal_notify.notify
    NOTES = []
    portal_notify.notify = lambda cid, kind, title, detail="", **kw: NOTES.append(
        (cid, kind, title, detail, kw.get("dedupe_key"))) or {}
    cl = app.test_client()
    try:
        api = "/api/v1/portal/ab-tests"
        # --- auth ---------------------------------------------------------------
        ab.authenticate_portal_request = lambda: None
        check("api: signed out -> 401", cl.get(api).status_code == 401)
        ab.authenticate_portal_request = lambda: {"client_id": 7, "role": "owner", "via_api_key": True}
        check("api: API keys cannot start tests (read-only keys)",
              cl.post(api, json={"variants": ["a", "b"]}).status_code == 403)
        ab.authenticate_portal_request = lambda: dict(who)

        body = cl.get(api).get_json()
        check("api: GET on a fresh workspace -> no tests, config with audiences (tables on demand)",
              body["tests"] == [] and body["config"]["max_variants"] == 3
              and body["config"]["max_recipients"] == portal_growth.BROADCAST_MAX_RECIPIENTS
              and [a["key"] for a in body["config"]["audiences"]] == ["all", "open", "hot"]
              and body["config"]["audiences"][0]["label"] == "All customers", body)
        sql("CREATE TABLE IF NOT EXISTS portal_segments (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL, filters JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
            fetch=False)
        seg = sql("INSERT INTO portal_segments (client_id, name, filters) VALUES (7, 'VIPs', '{}')"
                  " RETURNING id")[0][0]
        sql("INSERT INTO portal_segments (client_id, name, filters) VALUES (8, 'Theirs', '{}')", fetch=False)
        auds = cl.get(api).get_json()["config"]["audiences"]
        check("api: saved segments of THIS workspace become audiences",
              auds[-1] == {"key": "segment:%d" % seg, "label": "VIPs"}
              and all(a["label"] != "Theirs" for a in auds), auds)

        # --- validation / audience problems ------------------------------------
        res = cl.post(api, json={"variants": ["a"]})
        check("api: bad input -> 400 with the reason", res.status_code == 400
              and "2 to 3" in res.get_json()["error"]["message"])
        res = cl.post(api, json={"variants": ["a", "b"], "audience": "segment:999999"})
        check("api: empty audience -> 400 no_recipients", res.status_code == 400
              and res.get_json()["error"]["code"] == "no_recipients")
        cap = portal_growth.BROADCAST_MAX_RECIPIENTS
        portal_growth.BROADCAST_MAX_RECIPIENTS = 50
        res = cl.post(api, json={"variants": ["a", "b"]})
        check("api: over the broadcast cap -> 400 too_many_recipients (same cap as broadcasts)",
              res.status_code == 400 and res.get_json()["error"]["code"] == "too_many_recipients"
              and "more than 50" in res.get_json()["error"]["message"])
        portal_growth.BROADCAST_MAX_RECIPIENTS = cap
        res = cl.post(api, json={"variants": ["a", "b", "c"], "audience": "hot"})
        check("api: 3 hot leads, 3 versions -> allowed (1 each, everyone tested)",
              res.status_code == 200 and res.get_json()["plan"]["test_size"] == 3
              and res.get_json()["plan"]["rest_size"] == 0, res.get_json())
        sql("DELETE FROM portal_ab_assignments", fetch=False)
        sql("DELETE FROM portal_connector_commands", fetch=False)
        sql("DELETE FROM portal_broadcasts", fetch=False)
        sql("DELETE FROM portal_ab_tests", fetch=False)
        sql("UPDATE portal_conversations SET lead_temp = NULL WHERE contact_id = 'c003'", fetch=False)
        res = cl.post(api, json={"variants": ["a", "b", "c"], "audience": "hot"})
        check("api: fewer customers than versions -> 400 too_few_recipients",
              res.status_code == 400 and res.get_json()["error"]["code"] == "too_few_recipients")

        # --- dry run --------------------------------------------------------------
        spec = {"name": "Eid sale", "variants": ["Hi {name}! Eid sale 20% off", "Salam {name}, Eid offer"],
                "test_percent": 50, "decide_hours": 24}
        res = cl.post(api, json=dict(spec, dry_run=True))
        plan = res.get_json()["plan"]
        check("dry run: plan from the live audience (opt-out removed), nothing written",
              res.status_code == 200 and plan["audience_size"] == 60 and plan["test_size"] == 30
              and plan["per_variant"] == 15 and plan["rest_size"] == 30
              and "about 15 customers" in plan["warnings"][0]
              and sql("SELECT COUNT(*) FROM portal_ab_tests")[0][0] == 0
              and sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0] == 0, plan)
        res = cl.post(api, json=dict(spec, dry_run=True, test_percent=100, auto_winner=True))
        check("dry run: 100% -> no rest, auto off, a 'for learning' note",
              res.get_json()["plan"]["rest_size"] == 0 and res.get_json()["plan"]["auto_winner"] is False
              and "no 'rest'" in res.get_json()["plan"]["warnings"][-1])

        # --- plan limit (also with the plan table missing) ----------------------
        real_enforce = portal_plans.enforce
        portal_plans.enforce = lambda *a, **k: (jsonify({"error": {"code": "plan_limit",
                                                                   "message": "Monthly broadcast plan limit reached (100)"}}), 409)
        res = cl.post(api, json=spec)
        check("plan: monthly broadcast limit -> 409 plan_limit, nothing sent",
              res.status_code == 409 and res.get_json()["error"]["code"] == "plan_limit"
              and sql("SELECT COUNT(*) FROM portal_ab_tests")[0][0] == 0
              and sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0] == 0)
        portal_plans.enforce = real_enforce
        check("plan: the plan-settings table does not exist on this fresh database",
              sql("SELECT to_regclass('portal_plan_settings')")[0][0] is None)

        # --- start a real test ------------------------------------------------------
        res = cl.post(api, json=spec)
        out = res.get_json()
        check("start: 200 with the id - works although the plan table is missing (savepoint, fail-open)",
              res.status_code == 200 and out["ok"] and out["plan"]["test_size"] == 30, out)
        t1 = out["id"]
        rows = sql("SELECT contact_id, variant, phase, sent_at FROM portal_ab_assignments"
                   " WHERE test_id = %s ORDER BY contact_id", (t1,))
        check("start: 30 customers assigned, 15 per version, all in the test phase",
              len(rows) == 30 and sum(1 for r in rows if r[1] == "A") == 15
              and all(r[2] == "test" for r in rows))
        check("start: opted-out customer never assigned or messaged",
              all(r[0] != "c061" for r in rows)
              and sql("SELECT COUNT(*) FROM portal_connector_commands WHERE payload->>'external_user_id' = 'c061'")[0][0] == 0)
        audience = sorted("c%03d" % i for i in range(1, 61))
        expect = ab.assign(audience, ["A", "B"], "7:%d" % t1)[:30]
        check("start: the assignment is the seeded random split (reproducible)",
              sorted(expect) == sorted((r[0], r[1]) for r in rows))
        bcast = sql("SELECT id, audience, body, recipient_count, send_at FROM portal_broadcasts"
                    " WHERE client_id = 7 ORDER BY id")
        check("start: one ordinary broadcast row per version (history + counts reuse), no auto slot",
              [(b[1], b[3]) for b in bcast] == [("ab:%d:A" % t1, 15), ("ab:%d:B" % t1, 15)]
              and bcast[0][2] == spec["variants"][0] and bcast[0][4] is None, bcast)
        cmds = sql("SELECT payload->>'external_user_id', payload->>'body', payload->>'broadcast_id',"
                   " payload->>'source', status FROM portal_connector_commands WHERE client_id = 7")
        a_ids = {r[0] for r in rows if r[1] == "A"}
        check("start: 30 queued sends through the broadcast engine, right version + {name}",
              len(cmds) == 30 and all(c[3] == "broadcast" and c[4] == "pending" for c in cmds)
              and all((c[2] == str(bcast[0][0])) == (c[0] in a_ids) for c in cmds)
              and any(c[1].startswith("Hi Ali") and "Eid sale 20% off" in c[1] for c in cmds)
              and all("{name}" not in c[1] for c in cmds), cmds[:2])
        check("start: audited as broadcast.sent (webhook subscribers see the send-out)",
              sql("SELECT COUNT(*) FROM portal_action_log WHERE client_id = 7 AND action = 'broadcast.sent'"
                  " AND note LIKE %s", ("A/B test 'Eid sale': 2 versions sent to 30%",))[0][0] == 1)

        # --- attribution -------------------------------------------------------------
        sent_at = rows[0][3]
        a_list = sorted(r[0] for r in rows if r[1] == "A")
        b_list = sorted(r[0] for r in rows if r[1] == "B")
        conv = {r[0]: r[1] for r in sql("SELECT contact_id, id FROM portal_conversations WHERE client_id = 7")}
        conv8 = {r[0]: r[1] for r in sql("SELECT contact_id, id FROM portal_conversations WHERE client_id = 8")}

        def msg(contact, hours, direction="in", client=7):
            table = conv if client == 7 else conv8
            sql("INSERT INTO portal_messages (conversation_id, client_id, direction, body, created_at)"
                " VALUES (%s, %s, %s, 'x', %s + make_interval(mins => %s))",
                (table[contact], client, direction, sent_at, int(hours * 60)), fetch=False)

        for contact in a_list[:12]:
            msg(contact, 1)
        msg(a_list[0], 2)              # second reply, same customer -> still one
        msg(b_list[0], 3)
        msg(b_list[1], -1)             # replied BEFORE the broadcast -> not counted
        msg(b_list[2], 25)             # after the 24h window -> not counted
        msg(b_list[3], 1, "out")       # our own message -> not a reply
        if b_list[4] not in conv8:
            conv8[b_list[4]] = sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name)"
                                   " VALUES (8, %s, 'Other') RETURNING id", (b_list[4],))[0][0]
        msg(b_list[4], 1, client=8)    # same phone, other business -> not counted

        def order(contact, hours, status, total, client=7):
            sql("INSERT INTO portal_checkout_links (client_id, token, contact_id, title, total, status, created_at)"
                " VALUES (%s, md5(random()::text), %s, 'o', %s, %s, %s + make_interval(mins => %s))",
                (client, contact, total, status, sent_at, int(hours * 60)), fetch=False)

        order(a_list[0], 2, "paid", 1500)
        order(a_list[0], 3, "delivered", 500)
        order(a_list[1], 2, "open", 999)         # unpaid -> not a paid order
        order(b_list[0], 5, "shipped", 2000)
        order(b_list[1], -2, "paid", 700)        # before the send -> no
        order(b_list[2], 30, "paid", 700)        # after the window -> no
        order(b_list[3], 2, "paid", 900, client=8)  # other business -> no
        listed = cl.get(api).get_json()["tests"]
        t = listed[0]
        va, vb = t["variants"]
        check("results: replies = distinct customers replying inside THEIR window (in only)",
              va["replied"] == 12 and vb["replied"] == 1 and va["sent"] == 15 and vb["sent"] == 15,
              (va, vb))
        check("results: paid orders / sales = paid|shipped|delivered inside the window, this workspace",
              va["ordered"] == 1 and va["sales"] == 2000.0 and vb["ordered"] == 1 and vb["sales"] == 2000.0,
              (va, vb))
        check("results: rates for the owner", va["reply_rate"] == 80.0 and vb["reply_rate"] == 6.7
              and va["order_rate"] == 6.7)
        check("results: the honest default bar -> 15 per version is below 20, no clear winner",
              t["decision"]["clear"] is False and t["decision"]["leader"] == "A"
              and "at least 20 (smallest got 15)" in t["decision"]["reason"], t["decision"])
        ab.MIN_PER_VARIANT = 10
        t = cl.get(api).get_json()["tests"][0]
        check("results: with the bar met, A clearly wins on replies",
              t["decision"]["clear"] and t["decision"]["winner"] == "A" and t["decision"]["confidence"] > 99,
              t["decision"])
        check("results: status fields (running, window open, rest 30, no auto)",
              t["status"] == "running" and t["window_over"] is False and t["rest_size"] == 30
              and t["auto_winner"] is False and t["auto_pending"] is False and t["decide_at"], t)
        sql("UPDATE portal_connector_commands SET status = 'done' WHERE payload->>'broadcast_id' = %s",
            (str(bcast[0][0]),), fetch=False)
        sql("UPDATE portal_connector_commands SET status = 'failed' WHERE id IN (SELECT id FROM"
            " portal_connector_commands WHERE payload->>'broadcast_id' = %s LIMIT 2)", (str(bcast[1][0]),),
            fetch=False)
        t = cl.get(api).get_json()["tests"][0]
        check("results: delivery counts per version from the command queue",
              t["variants"][0]["delivered"] == 15 and t["variants"][1]["failed"] == 2
              and t["variants"][1]["delivered"] == 0)

        # --- isolation -----------------------------------------------------------------
        who["client_id"] = 8
        check("isolation: another workspace sees no tests and cannot decide / cancel ours",
              cl.get(api).get_json()["tests"] == []
              and cl.post(api + "/%d/winner" % t1, json={"variant": "A"}).status_code == 404
              and cl.post(api + "/%d/cancel" % t1).status_code == 404)
        who["client_id"] = 7

        # --- manual winner ---------------------------------------------------------------
        rest_pool = [c for c in audience if c not in {r[0] for r in rows}]
        sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (7, %s)", (rest_pool[0],), fetch=False)
        sql("INSERT INTO portal_conversations (client_id, contact_id, contact_name) VALUES (7, 'c099', 'Naya')",
            fetch=False)
        conv.update({r[0]: r[1] for r in sql("SELECT contact_id, id FROM portal_conversations WHERE client_id = 7")})
        check("winner: unknown version -> 400",
              cl.post(api + "/%d/winner" % t1, json={"variant": "Z"}).status_code == 400)
        res = cl.post(api + "/%d/winner" % t1, json={"variant": "a"})
        check("winner: sent to the rest = fresh audience minus tested minus opted-out",
              res.status_code == 200 and res.get_json() == {"ok": True, "winner": "A", "sent": 30},
              res.get_json())
        win_row = sql("SELECT id, body, recipient_count FROM portal_broadcasts WHERE audience = %s",
                      ("ab:%d:win" % t1,))
        winners = sql("SELECT contact_id FROM portal_ab_assignments WHERE test_id = %s AND phase = 'winner'",
                      (t1,))
        got_ids = {r[0] for r in winners}
        check("winner: rest excludes every tested customer and the new opt-out, includes the new customer",
              len(got_ids) == 30 and not (got_ids & {r[0] for r in rows}) and rest_pool[0] not in got_ids
              and "c099" in got_ids and "c061" not in got_ids, sorted(got_ids)[:5])
        check("winner: a broadcast row with the winning text + queued sends tagged to it",
              win_row and win_row[0][1] == spec["variants"][0] and win_row[0][2] == 30
              and sql("SELECT COUNT(*) FROM portal_connector_commands WHERE payload->>'broadcast_id' = %s",
                      (str(win_row[0][0]),))[0][0] == 30)
        t = cl.get(api).get_json()["tests"][0]
        check("winner: test completed (manual), rest_sent kept; test-phase results unchanged",
              t["status"] == "completed" and t["winner"] == "A" and t["winner_reason"] == "manual"
              and t["rest_sent"] == 30 and t["variants"][0]["sent"] == 15, t)
        check("winner: a second decision -> 409",
              cl.post(api + "/%d/winner" % t1, json={"variant": "B"}).status_code == 409)
        acts = [r[0] for r in sql("SELECT action FROM portal_action_log WHERE client_id = 7 ORDER BY id")]
        check("winner: audited (broadcast.sent for the send-out + abtest.winner_chosen)",
              acts[-2:] == ["broadcast.sent", "abtest.winner_chosen"], acts)

        # --- cancel with a pending auto slot -----------------------------------------------
        res = cl.post(api, json=dict(spec, name="Auto one", auto_winner=True, decide_hours=6))
        t2 = res.get_json()["id"]
        slot = sql("SELECT id, recipient_count, send_at - created_at, materialized_at FROM portal_broadcasts"
                   " WHERE audience = %s", ("ab:%d:win" % t2,))
        check("auto: a scheduled slot on the broadcast scheduler at the decision time",
              len(slot) == 1 and slot[0][1] == 30 and abs(slot[0][2].total_seconds() - 6 * 3600) < 5
              and slot[0][3] is None, slot)
        t = [x for x in cl.get(api).get_json()["tests"] if x["id"] == t2][0]
        check("auto: listed as pending", t["auto_winner"] and t["auto_pending"] is True)
        res = cl.post(api + "/%d/cancel" % t2)
        check("cancel: 200, slot removed, test cancelled, audited",
              res.status_code == 200 and not sql("SELECT 1 FROM portal_broadcasts WHERE id = %s", (slot[0][0],))
              and sql("SELECT status FROM portal_ab_tests WHERE id = %s", (t2,))[0][0] == "cancelled"
              and sql("SELECT action FROM portal_action_log ORDER BY id DESC LIMIT 1")[0][0] == "abtest.cancelled")
        check("cancel: twice -> 409", cl.post(api + "/%d/cancel" % t2).status_code == 409)

        # --- running cap ----------------------------------------------------------------------
        ab.MAX_RUNNING = 1
        res3 = cl.post(api, json=dict(spec, name="Auto clear", auto_winner=True, decide_hours=2))
        t3 = res3.get_json()["id"]
        res = cl.post(api, json=dict(spec, name="One too many"))
        check("cap: only MAX_RUNNING tests at once -> 409", res.status_code == 409
              and "already have 1" in res.get_json()["error"]["message"])
        ab.MAX_RUNNING = 5

        # --- automatic winner via the scheduler ---------------------------------------------
        rows3 = sql("SELECT contact_id, variant, sent_at FROM portal_ab_assignments WHERE test_id = %s", (t3,))
        sent_at = rows3[0][2]
        for contact, variant, _s in rows3:
            if variant == "B":
                msg(contact, 0.5)
        slot3 = sql("SELECT id FROM portal_broadcasts WHERE audience = %s", ("ab:%d:win" % t3,))[0][0]
        before = sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0]

        def tick():
            c = connect()
            try:
                with c.cursor() as cur:
                    portal_growth._SCHEDULE_COLUMNS_READY = True
                    n = portal_growth.materialize_due_broadcasts(cur, 7, c)
                c.commit()
                return n
            finally:
                c.close()

        check("auto: before the decision time the tick does nothing", tick() == 0
              and sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0] == before)
        sql("UPDATE portal_broadcasts SET send_at = NOW() - interval '1 minute' WHERE id = %s", (slot3,),
            fetch=False)
        NOTES.clear()
        check("auto: due slot -> the tick hands it to the A/B engine", tick() == 1)
        row = sql("SELECT body, recipient_count, materialized_at FROM portal_broadcasts WHERE id = %s", (slot3,))[0]
        t = [x for x in cl.get(api).get_json()["tests"] if x["id"] == t3][0]
        check("auto: clear winner B sent to the rest through the slot row",
              t["status"] == "completed" and t["winner"] == "B" and t["winner_reason"] == "auto"
              and row[0] == spec["variants"][1] and row[1] == t["rest_sent"] > 0 and row[2] is not None
              and sql("SELECT COUNT(*) FROM portal_connector_commands WHERE payload->>'broadcast_id' = %s",
                      (str(slot3),))[0][0] == t["rest_sent"], (t, row))
        check("auto: owner told the winner (deduped per test)",
              NOTES and NOTES[0][0] == 7 and "version B won" in NOTES[0][2]
              and NOTES[0][4] == "abtest:%d:sent" % t3, NOTES)
        check("auto: the system actor audited the decision",
              sql("SELECT actor_kind FROM portal_action_log WHERE action = 'abtest.winner_chosen'"
                  " ORDER BY id DESC LIMIT 1")[0][0] == "system")
        check("auto: an already materialised slot is never picked up again", tick() == 0)

        # unclear -> skipped, owner decides (fresh inbox: earlier replies would fall in its window)
        sql("DELETE FROM portal_messages", fetch=False)
        res = cl.post(api, json=dict(spec, name="Unclear", auto_winner=True, decide_hours=1))
        t4 = res.get_json()["id"]
        slot4 = sql("SELECT id FROM portal_broadcasts WHERE audience = %s", ("ab:%d:win" % t4,))[0][0]
        sql("UPDATE portal_broadcasts SET send_at = NOW() - interval '1 minute' WHERE id = %s", (slot4,),
            fetch=False)
        before = sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0]
        NOTES.clear()
        tick()
        row = sql("SELECT body, recipient_count, materialized_at FROM portal_broadcasts WHERE id = %s", (slot4,))[0]
        t = [x for x in cl.get(api).get_json()["tests"] if x["id"] == t4][0]
        check("auto: no clear winner -> nothing sent, slot closed with the reason in its text",
              sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0] == before
              and row[1] == 0 and row[2] is not None and row[0].endswith("(not sent: no clear winner)"), row)
        check("auto: the test stays open for the owner, with the note; not pending any more",
              t["status"] == "running" and t["auto_pending"] is False
              and t["auto_note"].startswith("Automatic send skipped: Too few replies"), t)
        check("auto: owner notified to decide",
              NOTES and "needs your decision" in NOTES[0][2] and NOTES[0][4] == "abtest:%d:skipped" % t4, NOTES)
        calls = []
        portal_plans.enforce = lambda *a, **k: calls.append(a[1:]) or None
        res = cl.post(api + "/%d/winner" % t4, json={"variant": "B"})
        portal_plans.enforce = real_enforce
        check("auto: the owner can still pick -> a NEW broadcast row, plan checked for it",
              res.status_code == 200 and res.get_json()["sent"] > 0
              and calls == [(7, "broadcasts_per_month", "Monthly broadcast")]
              and sql("SELECT COUNT(*) FROM portal_broadcasts WHERE audience = %s", ("ab:%d:win" % t4,))[0][0] == 2)

        # slot cancelled from the Scheduled list -> auto is off
        res = cl.post(api, json=dict(spec, name="Slot gone", auto_winner=True))
        t5 = res.get_json()["id"]
        sql("DELETE FROM portal_broadcasts WHERE audience = %s", ("ab:%d:win" % t5,), fetch=False)
        t = [x for x in cl.get(api).get_json()["tests"] if x["id"] == t5][0]
        check("auto: deleting the scheduled slot turns auto off (shown honestly)",
              t["auto_winner"] is True and t["auto_pending"] is False and t["status"] == "running")
        # stale slot: points at a cancelled test
        cl.post(api + "/%d/cancel" % t5)
        stale = sql("INSERT INTO portal_broadcasts (client_id, audience, body, recipient_count, send_at)"
                    " VALUES (7, %s, 'x', 9, NOW() - interval '1 minute') RETURNING id", ("ab:%d:win" % t5,))[0][0]
        before = sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0]
        NOTES.clear()
        tick()
        check("auto: a stale slot (test not running) is closed with 0 recipients, nothing sent, nobody nagged",
              sql("SELECT recipient_count, materialized_at IS NOT NULL FROM portal_broadcasts WHERE id = %s",
                  (stale,))[0] == (0, True)
              and sql("SELECT COUNT(*) FROM portal_connector_commands")[0][0] == before
              and NOTES == [] and sql("SELECT auto_note FROM portal_ab_tests WHERE id = %s", (t5,))[0][0] == "",
              NOTES)
        # failing engine must not break a normal scheduled broadcast in the same tick
        res = cl.post(api, json=dict(spec, name="Boom", auto_winner=True))
        t6 = res.get_json()["id"]
        sql("UPDATE portal_broadcasts SET send_at = NOW() - interval '2 minute' WHERE audience = %s",
            ("ab:%d:win" % t6,), fetch=False)
        normal = sql("INSERT INTO portal_broadcasts (client_id, audience, body, recipient_count, send_at)"
                     " VALUES (7, 'hot', 'Hot deal {name}', 2, NOW() - interval '1 minute') RETURNING id")[0][0]
        real_mw = ab.materialize_winner

        def boom(cur, cid, row):
            cur.execute("SELECT * FROM table_that_does_not_exist")

        ab.materialize_winner = boom
        n = tick()
        ab.materialize_winner = real_mw
        hot_ok = sql("SELECT COUNT(*) FROM portal_conversations c WHERE c.client_id = 7 AND c.lead_temp = 'hot'"
                     " AND NOT EXISTS (SELECT 1 FROM portal_optouts o WHERE o.client_id = 7"
                     " AND o.contact_id = c.contact_id)")[0][0]
        check("isolation: engine failure -> slot closed (0), the normal scheduled broadcast still sent"
              " (to every hot lead that has not opted out)",
              n == 2 and sql("SELECT recipient_count, materialized_at IS NOT NULL FROM portal_broadcasts"
                             " WHERE audience = %s", ("ab:%d:win" % t6,))[0] == (0, True)
              and sql("SELECT COUNT(*) FROM portal_connector_commands WHERE payload->>'broadcast_id' = %s",
                      (str(normal),))[0][0] == hot_ok > 0,
              (n, sql("SELECT payload FROM portal_connector_commands WHERE payload->>'broadcast_id' = %s",
                      (str(normal),)), sql("SELECT contact_id FROM portal_optouts WHERE client_id = 7")))
        check("isolation: the failed slot left the test running for a manual pick",
              sql("SELECT status FROM portal_ab_tests WHERE id = %s", (t6,))[0][0] == "running")
        ab.MIN_PER_VARIANT = 20
    finally:
        ab.authenticate_portal_request = real_auth
        portal_notify.notify = real_notify
    server.cleanup()


db_half()

# ---------------------------------------------------------------------------
print("== wiring ==")
CP = os.getcwd()


def read(rel, base=None):
    with open(os.path.join(base or ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


growth_src = read("portal_growth.py", CP)
hook = growth_src.split("def materialize_due_broadcasts")[1].split("\ndef ")[0]
check("growth: only ab:<id>:win slots go to the engine, inside a savepoint",
      'audience.startswith("ab:") and audience.endswith(":win")' in hook
      and "SAVEPOINT of_ab_win" in growth_src and "ROLLBACK TO SAVEPOINT of_ab_win" in growth_src)
check("growth: no new query on the tick (still the due-row SELECT + the materialised UPDATE)",
      hook.count("cur.execute(") == 2)
app_src = read("app.py", CP)
check("app: blueprint imported and registered",
      "from portal_ab_tests import bp as portal_ab_tests_bp" in app_src
      and "register_blueprint(portal_ab_tests_bp)" in app_src)
ab_src = read("portal_ab_tests.py", CP)
check("engine: reuses the broadcast engine (resolver, sender, cap, plan), no own sender",
      "portal_growth._resolve_recipients" in ab_src and "portal_growth._send_command" in ab_src
      and "BROADCAST_MAX_RECIPIENTS" in ab_src and "portal_plans.enforce" in ab_src
      and "INSERT INTO \" + portal_db._q(portal_db.CMD_TABLE)" not in ab_src)
check("engine: GET reads under a statement timeout", "SET LOCAL statement_timeout" in ab_src)

print("== web pins ==")
portal_ts = read("lib/omniflow/portal.ts")
check("web: portal.ts helpers", all(name in portal_ts for name in (
    "export async function listAbTests", "export async function startAbTest",
    "export async function chooseAbWinner", "export async function cancelAbTest")))
list_route = read("app/api/omniflow/portal/ab-tests/route.ts")
win_route = read("app/api/omniflow/portal/ab-tests/[id]/winner/route.ts")
cancel_route = read("app/api/omniflow/portal/ab-tests/[id]/cancel/route.ts")
check("web: BFF routes (same-origin on writes, send time budget, input checked)",
      "export async function GET" in list_route and "export async function POST" in list_route
      and "}, request)" in list_route and "maxDuration" in list_route and "abInputFromBody" in list_route
      and "}, request)" in win_route and "/^[A-D]$/" in win_route and "maxDuration" in win_route
      and "}, request)" in cancel_route)
page = read("app/dashboard/(portal)/broadcasts/page.tsx")
panel = read("app/dashboard/(portal)/broadcasts/ABTests.tsx")
copygen = read("app/dashboard/(portal)/broadcasts/CopyGenCard.tsx")
check("web: Broadcasts page shows the A/B tests panel", "<ABTests />" in page and "A/B tests" in panel)
check("web: review (dry run) before sending, confirm on winner / cancel",
      "dryRun" in panel and "Review" in panel and "Start test" in panel
      and "Confirm" in panel and "Cancel test" in panel)
check("web: honest copy - attribution window, auto only when clear",
      "within" in panel and "only if one version clearly wins" in panel)
check("web: AI copy helper hands its versions to the A/B form",
      "AB_PREFILL_EVENT" in copygen and "A/B test these versions" in copygen
      and "AB_PREFILL_EVENT" in panel)
history = read("app/dashboard/(portal)/broadcasts/BroadcastsClient.tsx")
sched = read("app/dashboard/(portal)/broadcasts/ScheduleCard.tsx")
check("web: history and scheduled list label A/B rows", "A/B version" in history and "A/B winner" in history
      and "A/B winner (only if clear)" in sched)
check("web: text glyphs only (no emoji-capable code points)",
      not re.search("[\u25b6\u261d\u2714\u26a1\u2699\u2709\u260e\u2733\u263a\u25fc\u27a1]", panel + copygen))
sys.exit(1 if summary("ab_tests") else 0)
