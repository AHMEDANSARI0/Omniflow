"""§236 transaction guard: one broken feature must not lose the customer's
message or break the rest of a shared transaction.

Unit half: portal_txn semantics on a fake connection (no SQL issued when
the connection cannot report its status), the policy boolean fix, source
pins. Database half (pgserver): the real failure mode - a hook that
swallows an SQL error - first WITHOUT the guard (the message is lost),
then with it (stored); every guarded helper keeps the transaction usable.
"""
import os
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in list(os.environ):
    if name.startswith(("OF_LLM_", "OF_ROUTER_")):
        os.environ.pop(name)
os.environ["OF_LLM_ENABLED"] = "0"
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
CP = os.getcwd()

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_txn  # noqa: E402
import portal_policy  # noqa: E402


def read(name):
    with open(os.path.join(CP, name), encoding="utf8") as handle:
        return handle.read()


print("== guard on a connection without status (test doubles) ==")


class Cur:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append(sql)


cur = Cur()
with portal_txn.savepoint(cur, object(), "of_x") as guard:
    pass
check("no status -> no SQL at all (scripted tests keep their slots)", cur.executed == [] and not guard.failed)
try:
    with portal_txn.savepoint(cur, object(), "of_x") as guard:
        raise ValueError("boom")
    raised = False
except ValueError:
    raised = True
check("no status: the exception still propagates, failed is set", raised and guard.failed)
check("status_of: None for objects without conn.info", portal_txn.status_of(object()) is None)

print("== policy: booleans compare as true/false ==")
check("_as_text(False) == 'false'", portal_policy._as_text(False) == "false")
check("_as_text(True) == 'true'", portal_policy._as_text(True) == "true")
check("in_hours is false matches outside hours",
      portal_policy.evaluate({"all": [{"field": "in_hours", "op": "is", "value": "false"}]}, {"in_hours": False}))
check("in_hours is false does not match inside hours",
      not portal_policy.evaluate({"all": [{"field": "in_hours", "op": "is", "value": "false"}]}, {"in_hours": True}))
check("equals uses the same rule",
      portal_policy.evaluate({"all": [{"field": "in_hours", "op": "equals", "value": "TRUE"}]}, {"in_hours": True}))
check("text values unchanged",
      portal_policy.evaluate({"all": [{"field": "intent", "op": "is", "value": "Order"}]}, {"intent": "order"}))

print("== source pins ==")
src = read("connector_api.py")
check("every ingest hook is guarded (>= 20 of_hook savepoints)", src.count('"of_hook"') >= 20, src.count('"of_hook"'))
check("ingest rate limiter guarded", '"of_ingest_rl"' in src)
check("tick steps guarded separately", src.count('"of_tick"') >= 8, src.count('"of_tick"'))
check("business hours read guarded", '"of_hours"' in src)
for module, marker in (("portal_bi.py", "of_bi_tz"), ("portal_plans.py", "of_plan_check"),
                       ("portal_growth.py", "of_segment"), ("portal_growth.py", "of_send_cmd"),
                       ("portal_policy.py", "of_rules"), ("portal_ai_quality.py", "of_quality_traces"),
                       ("portal_ai_quality.py", "of_quality_usage")):
    check("guard " + marker + " in " + module, marker in read(module))


def db_half():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="txn236_")
    server = pgserver.get_server(data, cleanup_mode="stop")  # noqa: F841
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

    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())", fetch=False)

    # --- the guard itself -------------------------------------------------
    c = connect()
    cur = c.cursor()
    cur.execute("CREATE TEMP TABLE t (v INT)")
    with portal_txn.savepoint(cur, c, "of_a") as guard:
        cur.execute("INSERT INTO t VALUES (1)")
    check("db: success -> released, row kept", not guard.failed)
    try:
        with portal_txn.savepoint(cur, c, "of_b") as guard:
            cur.execute("INSERT INTO t VALUES (2)")
            cur.execute("SELECT * FROM missing_table_236")
        raised = False
    except Exception:
        raised = True
    check("db: raising step -> rolled back, exception propagates", raised and guard.failed)
    with portal_txn.savepoint(cur, c, "of_c") as guard:
        cur.execute("INSERT INTO t VALUES (3)")
        try:
            cur.execute("SELECT * FROM missing_table_236")
        except Exception:
            pass  # the step swallowed its own SQL error
    check("db: swallowed SQL error -> detected (failed), step rolled back", guard.failed)
    cur.execute("SELECT array_agg(v ORDER BY v) FROM t")
    check("db: transaction usable; only the good step's row is kept", cur.fetchone()[0] == [1])
    c.rollback()
    with portal_txn.savepoint(cur, c, "of_d") as guard:
        cur.execute("CREATE TEMP TABLE IF NOT EXISTS t2 (v INT)")
        c.commit()  # the step committed by itself
    cur.execute("SELECT 1")
    check("db: a step that committed -> nothing released/rolled back, still usable",
          not guard.failed and cur.fetchone() == (1,))
    c.rollback()
    c.close()

    # a step that commits and then keeps writing: the later work must stay
    # in the caller's transaction (it was lost when RELEASE failed)
    sql("CREATE TABLE IF NOT EXISTS t236 (v INT)", fetch=False)
    c = connect()
    cur = c.cursor()
    cur.execute("INSERT INTO t236 VALUES (1)")
    with portal_txn.savepoint(cur, c, "of_e") as guard:
        cur.execute("INSERT INTO t236 VALUES (2)")
        c.commit()
        cur.execute("INSERT INTO t236 VALUES (3)")
    cur.execute("INSERT INTO t236 VALUES (4)")
    c.commit()
    c.close()
    check("db: commit then more work inside a step -> nothing lost, not failed",
          not guard.failed and sql("SELECT array_agg(v ORDER BY v) FROM t236")[0][0] == [1, 2, 3, 4],
          sql("SELECT array_agg(v ORDER BY v) FROM t236"))
    c = connect()
    cur = c.cursor()
    try:
        with portal_txn.savepoint(cur, c, "of_f") as guard:
            c.commit()
            cur.execute("INSERT INTO t236 VALUES (5)")
            raise RuntimeError("hook broke after its commit")
    except RuntimeError:
        pass
    cur.execute("INSERT INTO t236 VALUES (6)")
    c.commit()
    c.close()
    check("db: commit then raise -> marked failed, caller's transaction still usable",
          guard.failed and sql("SELECT array_agg(v ORDER BY v) FROM t236")[0][0] == [1, 2, 3, 4, 5, 6])

    # wrappers (the sandbox's savepoint views) are left alone
    class View:
        def __init__(self, real):
            self._real = real

        def __getattr__(self, name):
            return getattr(self._real, name)

    c = connect()
    view = View(c)
    check("wrapper connection -> no transaction status (guard steps aside)",
          portal_txn.status_of(view) is None and portal_txn.status_of(c) == 0)
    cur = c.cursor()
    with portal_txn.savepoint(cur, view, "of_g") as guard:
        pass
    check("wrapper connection -> no savepoint issued", guard.active is False)
    c.close()

    # --- the real failure mode: a hook that swallows an SQL error ---------
    import connector_api
    import portal_cod

    original = portal_cod.maybe_cod_flow

    def broken_hook(cur, *args, **kwargs):
        try:
            cur.execute("SELECT nope FROM portal_messages")
        except Exception:
            pass
        return False

    def stored(body):
        return sql("SELECT COUNT(*) FROM portal_messages WHERE client_id = 7 AND body = %s", (body,))[0][0]

    def ingest(body, sender):
        items = connector_api.normalize_messages([{"from": sender, "body": body, "direction": "in",
                                                   "name": "Ali", "id": "wamid-" + body}])
        return connector_api.ingest_messages_for_tenant({"client_id": 7}, items)

    portal_cod.maybe_cod_flow = broken_hook
    real_status = portal_txn.status_of
    portal_txn.status_of = lambda conn: None  # guard steps aside = the old code path
    try:
        try:
            ingest("before guard", "923001110001@c.us")
        except Exception:
            pass
    finally:
        portal_txn.status_of = real_status
    check("db: WITHOUT the guard a swallowed hook error loses the message (the bug)",
          stored("before guard") == 0, stored("before guard"))
    try:
        result = ingest("with guard", "923001110002@c.us")
    except Exception as error:
        result = repr(error)
    finally:
        portal_cod.maybe_cod_flow = original
    check("db: WITH the guard the message is stored", stored("with guard") == 1, result)

    # --- guarded helpers keep the caller's transaction usable --------------
    import portal_growth
    import portal_plans
    import portal_bi

    c = connect()
    cur = c.cursor()
    rules = portal_policy.rules_summary(cur, 7)
    cur.execute("SELECT 5")
    check("db: rules_summary on a bare database -> list, transaction usable",
          isinstance(rules, list) and cur.fetchone() == (5,))
    got = portal_plans.check(cur, 7, "messages_per_month")
    cur.execute("SELECT 6")
    check("db: plans.check on a bare database -> ok, transaction usable",
          got.get("ok") is True and cur.fetchone() == (6,), got)
    members = portal_growth._segment_recipients(cur, 7, 999)
    cur.execute("SELECT 7")
    check("db: segment recipients for a missing segment -> [], usable", members == [] and cur.fetchone() == (7,))
    offset = portal_bi.timezone_offset_hours(cur, 7)
    cur.execute("SELECT 8")
    check("db: bi timezone on a bare database -> int, usable", isinstance(offset, int) and cur.fetchone() == (8,))
    c.rollback()
    c.close()

    sql("ALTER TABLE portal_optouts RENAME TO portal_optouts_off", fetch=False)
    c = connect()
    cur = c.cursor()
    portal_growth._send_command(cur, 7, "923001110003@c.us", "Ali", "Hello", "test")
    c.commit()
    c.close()
    sql("ALTER TABLE portal_optouts_off RENAME TO portal_optouts", fetch=False)
    check("db: send without the opt-out table falls back and queues (fallback now reachable)",
          sql("SELECT COUNT(*) FROM portal_connector_commands WHERE client_id = 7"
              " AND payload->>'external_user_id' = '923001110003@c.us'")[0][0] == 1)
    sql("INSERT INTO portal_optouts (client_id, contact_id) VALUES (7, '923001110004@c.us')", fetch=False)
    c = connect()
    cur = c.cursor()
    portal_growth._send_command(cur, 7, "923001110004@c.us", "Ali", "Hello", "test")
    c.commit()
    c.close()
    check("db: opted-out contact still never queued",
          sql("SELECT COUNT(*) FROM portal_connector_commands WHERE client_id = 7"
              " AND payload->>'external_user_id' = '923001110004@c.us'")[0][0] == 0)


db_half()
sys.exit(1 if summary("txn_guard") else 0)
