"""§225 Action Engine v2 + event catalog / webhook outbox - real PostgreSQL.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
Unit helpers + website pins run without a database; the ledger,
idempotency, atomicity, timeout/retry and outbox flows run on `pgserver`
(a real PostgreSQL 16) and are skipped with a note when it is missing.
"""
import ast
import glob
import json
import os
import sys

from test_lib import check, summary, human_principal, PrincipalStub

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
import portal_actions as PA  # noqa: E402
import portal_event_catalog as EC  # noqa: E402
import portal_webhooks as W  # noqa: E402
import portal_workflows as WF  # noqa: E402

# ---------------------------------------------------------------------------
# unit: schemas, validation, preview, keys
# ---------------------------------------------------------------------------
print("== action schemas ==")
cat = {row["action"]: row for row in PA.catalog()}
check("every action publishes typed args", all(row["args"] for row in cat.values()))
check("every required arg is declared",
      all(set(spec["required"]) <= set(spec["args"])
          for spec in PA.ACTIONS.values()))
check("catalog marks required args",
      {a["name"]: a["required"] for a in cat["create_checkout_link"]["args"]}
      ["items"] is True)

ok_args, bad = PA.validate_args("request_refund", {
    "conversation_id": "12", "note": "x" * 400, "_actor": "agent:7",
    "extra": {"kept": True}})
check("numeric string id coerced", ok_args["conversation_id"] == 12 and not bad)
check("long text capped to max", len(ok_args["note"]) == 300)
check("undeclared keys pass through", ok_args["extra"] == {"kept": True}
      and ok_args["_actor"] == "agent:7")
for action, args, field in (
        ("request_refund", {"conversation_id": "abc"}, "conversation_id"),
        ("request_refund", {"conversation_id": True}, "conversation_id"),
        ("request_refund", {"conversation_id": -3}, "conversation_id"),
        ("create_checkout_link", {"contact_id": "c", "items": "hoodie"}, "items"),
        ("create_checkout_link", {"contact_id": "c", "items": [1]}, "items"),
        ("create_checkout_link", {"contact_id": "c", "items": [{}],
                                  "discount": -1}, "discount"),
        ("create_checkout_link", {"contact_id": "c", "items": [{}],
                                  "discount": "lots"}, "discount"),
        ("read_customer_memory", {"contact_id": "9" * 200}, "contact_id"),
        ("add_customer_note", {"contact_id": "c", "content": ["x"]}, "content")):
    _a, errs = PA.validate_args(action, args)
    check("invalid " + field + " rejected (" + action + ")", errs == [field], errs)
money, errs = PA.validate_args("create_checkout_link", {
    "contact_id": "c", "items": [{"name": "A"}] * 15, "discount": "250"})
check("number string coerced + list capped", money["discount"] == 250.0
      and len(money["items"]) == 10 and not errs)

try:
    PA.execute(None, 1, "t", "request_refund", {"conversation_id": "zz"})
    check("execute raises invalid_args", False)
except ValueError as error:
    check("execute raises invalid_args", str(error) == "invalid_args:conversation_id",
          str(error))
try:
    PA.execute(None, 1, "t", "nope", {})
    check("unknown action still ValueError", False)
except ValueError as error:
    check("unknown action still ValueError", str(error) == "unknown_action")

print("== preview ==")
LINK = {"contact_id": "923001112222@c.us",
        "items": [{"name": "Lawn", "qty": 1, "price": 3000}]}
view = PA.preview(None, 1, "owner", "create_checkout_link", dict(LINK, discount=200))
check("preview: discount -> high + approval", view["status"] == "preview"
      and view["risk"] == "high" and view["wouldBe"] == "approval_required", view)
check("preview hides internal args", "_actor" not in view["args"])
check("preview without discount -> executed", PA.preview(
    None, 1, "o", "create_checkout_link", LINK)["wouldBe"] == "executed")
deny = {"id": 7, "name": "Support", "allowed_actions": ["add_customer_note"],
        "max_risk": "medium", "can_auto_reply": True}
view = PA.preview(None, 1, "o", "create_checkout_link", LINK, agent=deny)
check("preview: agent envelope -> denied", view["wouldBe"] == "denied"
      and view["permitted"] is False and view["reason"], view)
check("execute(dry_run) == preview, cur untouched",
      PA.execute(None, 1, "o", "create_checkout_link", LINK,
                 dry_run=True)["status"] == "preview")

print("== idempotency keys ==")
check("key accepted", PA._clean_key("wf:12:3") == "wf:12:3")
check("blank key -> none", PA._clean_key("  ") is None)
check("unsafe key rejected", PA._clean_key("a b") is None
      and PA._clean_key("ki\u00f1") is None and PA._clean_key("x;drop") is None)

# ---------------------------------------------------------------------------
# unit: event catalog
# ---------------------------------------------------------------------------
print("== event catalog ==")
for key, spec in WF.TRIGGERS.items():
    for action in spec.get("actions") or []:
        check("workflow trigger " + key + " uses a catalog event", EC.known(action))
check("webhook events derive from the catalog",
      W.EVENT_ACTIONS == {n: s["category"] for n, s in EC.EVENTS.items()})
check("webhook subscriptions = all + categories",
      W.ALLOWED_EVENTS == ("all",) + tuple(EC.CATEGORIES))
check("every event has a known category",
      all(s["category"] in EC.CATEGORIES for s in EC.EVENTS.values()))
check("every category has an event",
      all(any(s["category"] == c for s in EC.EVENTS.values())
          for c in EC.CATEGORIES))
check("actions_for(all) = every event", EC.actions_for(["all"])
      == sorted(EC.EVENTS))
check("actions_for(cod)", EC.actions_for(["cod"])
      == ["cod.confirmed", "cod.declined"])
pub = EC.public_catalog()
check("public catalog links workflow triggers", next(
    e for e in pub["events"] if e["type"] == "cod.confirmed"
)["workflowTriggers"] == ["cod_confirmed"])

# every catalog event is written by real code (no aspirational events)
written, prefixes = set(), set()
for path in glob.glob("*.py"):
    tree = ast.parse(open(path, encoding="utf-8").read())
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = (node.func.attr if isinstance(node.func, ast.Attribute)
                else getattr(node.func, "id", ""))
        if name not in ("log_action", "_audit"):
            continue
        arg = node.args[2] if len(node.args) > 2 else None
        for kw in node.keywords:
            if kw.arg == "action":
                arg = kw.value
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            written.add(arg.value)
        elif isinstance(arg, ast.BinOp) and isinstance(arg.left, ast.Constant):
            prefixes.add(str(arg.left.value))
for event in EC.EVENTS:
    check("catalog event is written by code: " + event,
          event in written or any(event.startswith(p) and p.endswith(".")
                                  for p in prefixes))

# ---------------------------------------------------------------------------
# website pins
# ---------------------------------------------------------------------------
print("== website pins ==")
ROOT = os.path.dirname(os.getcwd()) + "/"


def web(path):
    with open(ROOT + path, encoding="utf8") as handle:
        return handle.read()


PORTAL = web("lib/omniflow/portal.ts")
for name in ("listActionRuns", "getEventCatalog", "replayDeadWebhookDeliveries"):
    check("portal.ts exports " + name, "export function " + name + "(" in PORTAL)
check("runs client encodes the status filter",
      "encodeURIComponent(status)" in PORTAL)
for route, method in (("actions/runs/route.ts", "GET"),
                      ("events/catalog/route.ts", "GET"),
                      ("webhooks/[id]/deliveries/replay-dead/route.ts", "POST")):
    src = web("app/api/omniflow/portal/" + route)
    check("BFF " + route + " uses the shared helpers",
          "withPortalToken" in src and "export async function " + method in src)
replay_src = web("app/api/omniflow/portal/webhooks/[id]/deliveries/replay-dead/route.ts")
check("replay BFF checks the origin", "}, request);" in replay_src)
check("replay BFF validates the id", "Number.isInteger" in replay_src)
settings = web("app/dashboard/(portal)/settings/page.tsx")
check("settings shows ActionRunsCard after DeliveriesCard",
      settings.index("<ActionRunsCard />") > settings.index("<DeliveriesCard />"))
card = web("app/dashboard/(portal)/settings/ActionRunsCard.tsx")
check("runs card: filters + replay + duration",
      "/api/omniflow/portal/actions/runs" in card and "Once-only" in card
      and "durationMs" in card and "Needs approval" in card)
integrations = web("app/dashboard/(portal)/integrations/page.tsx")
check("integrations reads categories from the catalog",
      "/api/omniflow/portal/events/catalog" in integrations
      and '{ value: "cod"' not in integrations)
check("createWebhook surfaces the one-time secret from webhook.secret",
      "(raw as Record<string, unknown>).secret" in PORTAL)
check("webhook rows map dead_count / dead",
      "row.dead_count" in PORTAL and "dead: row.dead === true" in PORTAL)
check("integrations: dead badge + bulk replay",
      "replay-dead" in integrations and "Replay failed" in integrations
      and "deadCount" in integrations)
for path, src in (("card", card), ("integrations", integrations)):
    check("no emoji-capable glyphs in " + path,
          not any(ch in src for ch in "\u25b6\u261d\u2714\u26a1\u2699"
                  "\u2709\u260e\u2733\u263a\u25fc\u27a1"))

# ---------------------------------------------------------------------------
# real PostgreSQL
# ---------------------------------------------------------------------------
try:
    import pgserver
    import psycopg2
except Exception:
    pgserver = None

if pgserver is None:
    print("  skip: pgserver not installed - database half not run")
    summary("actions_v2")
    sys.exit(0)

print("== action engine v2 on real PostgreSQL ==")
import importlib  # noqa: E402
import tempfile  # noqa: E402

data_dir = tempfile.mkdtemp(prefix="of_act_pg_")
server = pgserver.get_server(data_dir, cleanup_mode="stop")
os.environ.update({"DB_HOST": data_dir, "DB_PORT": "5432",
                   "DB_NAME": "postgres", "DB_USER": "postgres",
                   "DB_PASSWORD": "", "PGSSLMODE": "disable"})
import portal_db  # noqa: E402

check("real portal_db in use",
      os.path.dirname(os.path.abspath(portal_db.__file__)) == os.getcwd())
for name in ("portal_actions", "portal_approvals", "portal_webhooks",
             "portal_events", "portal_workflows", "portal_checkout"):
    if name in sys.modules:
        importlib.reload(sys.modules[name])
import portal_actions as PA  # noqa: E402,F811
import portal_approvals as A  # noqa: E402
import portal_checkout  # noqa: E402
import portal_events  # noqa: E402
import portal_webhooks as W  # noqa: E402,F811
import portal_workflows as WF  # noqa: E402,F811
from flask import Flask  # noqa: E402

notified = []
sys.modules["portal_notify"] = type(sys)("portal_notify")
sys.modules["portal_notify"].notify = lambda *a, **k: notified.append((a, k))


def raw_conn():
    return psycopg2.connect(host=data_dir, dbname="postgres", user="postgres")


def sql(query, params=None, fetch=True):
    c = raw_conn()
    try:
        with c.cursor() as cur:
            cur.execute(query, params)
            out = cur.fetchall() if fetch and cur.description else None
        c.commit()
        return out
    finally:
        c.close()


def one(query, params=None):
    rows = sql(query, params)
    return rows[0] if rows else None


portal_db.ensure_tables()
sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT, action TEXT, actor_kind TEXT, actor_user_id BIGINT,"
    " conversation_id BIGINT, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW())",
    fetch=False)
sql("CREATE TABLE IF NOT EXISTS portal_optouts (client_id BIGINT,"
    " contact_id TEXT)", fetch=False)
_c = raw_conn()
try:
    portal_checkout._ensure_checkout_tables(_c)
    _c.commit()
finally:
    _c.close()
CONV = one("INSERT INTO " + portal_db.CONV_TABLE + " (client_id, contact_id,"
           " contact_name) VALUES (1, '923001112222@c.us', 'Ayesha')"
           " RETURNING id")[0]


def run(fn):
    """fn(cur) inside one committed transaction."""
    c = portal_db._conn()
    try:
        with c.cursor() as cur:
            out = fn(cur)
        c.commit()
        return out
    finally:
        c.close()


def ex(action, args, **kw):
    return run(lambda cur: PA.execute(cur, 1, kw.pop("actor", "owner@x"),
                                      action, args, **kw))


def runs(where="TRUE", params=None):
    return sql("SELECT action, status, idempotency_key, attempts, error,"
               " duration_ms, args, outcome, approval_id FROM portal_action_runs"
               " WHERE " + where + " ORDER BY id", params)


# --- ledger on every call ----------------------------------------------------
out = ex("check_optout", {"contact_id": "923001112222@c.us"})
row = runs("action = 'check_optout'")[0]
check("low action executed + ledgered", out["status"] == "executed"
      and row[1] == "executed" and row[3] == 1 and row[5] is not None, row)
check("ledger args drop engine-internal keys", "_actor" not in row[6]
      and row[6]["contact_id"] == "923001112222@c.us", row[6])

# --- idempotency: exactly once ------------------------------------------------
msg = {"contact_id": "923001112222@c.us", "body": "Aap ka order ready hai"}
first = ex("queue_whatsapp_message", msg, idempotency_key="api:k1")
again = ex("queue_whatsapp_message", msg, idempotency_key="api:k1")
sent = one("SELECT COUNT(*) FROM portal_connector_commands WHERE"
           " payload->>'body' = 'Aap ka order ready hai'")[0]
check("same key twice -> one effect", sent == 1, sent)
check("repeat returns stored outcome", first["status"] == "executed"
      and again["status"] == "executed" and again.get("replayed") is True
      and again.get("runId"), again)
check("one ledger row per key", len(runs("idempotency_key = 'api:k1'")) == 1)
other = ex("check_optout", {"contact_id": "x"}, idempotency_key="api:k1")
check("key reused for another action -> refused",
      other == {"status": "error", "risk": "low",
                "error": "idempotency_key_reused"}, other)

# --- domain error -> ledgered, retry with same key allowed -------------------
try:
    ex("create_checkout_link", {"contact_id": "923001112222@c.us",
                                "items": [{"name": ""}]}, idempotency_key="api:k2")
    check("executor domain error still raises", False)
except ValueError as error:
    check("executor domain error still raises", "items missing" in str(error))
# the API caller never commits on ValueError; a workflow does - emulate it
c = portal_db._conn()
try:
    with c.cursor() as cur:
        try:
            PA.execute(cur, 1, "workflow:3", "create_checkout_link",
                       {"contact_id": "923001112222@c.us", "items": [{"name": ""}]},
                       idempotency_key="api:k2")
        except ValueError:
            pass
        cur.execute("SELECT 1")  # transaction still healthy
    c.commit()
finally:
    c.close()
check("failed attempt recorded as error",
      runs("idempotency_key = 'api:k2'")[0][1] == "error")
ok = ex("create_checkout_link", dict(LINK), idempotency_key="api:k2")
check("same key after a failure runs again", ok["status"] == "executed"
      and not ok.get("replayed"), ok)
check("exactly one link from the retried key",
      one("SELECT COUNT(*) FROM portal_checkout_links")[0] == 1)

# --- atomic executor: partial writes rolled back, caller tx survives --------
def boom(cur, client_id, args):
    cur.execute("INSERT INTO portal_action_log (client_id, action) VALUES"
                " (1, 'should.vanish')")
    raise RuntimeError("downstream exploded")


PA.ACTIONS["test_boom"] = {"description": "t", "risk": "medium", "required": [],
                           "args": {}, "run": boom}
c = portal_db._conn()
try:
    with c.cursor() as cur:
        res = PA.execute(cur, 1, "workflow:3", "test_boom", {})
        cur.execute("SELECT 41 + 1")
        alive = cur.fetchall()[0][0]
    c.commit()
finally:
    c.close()
check("unexpected failure -> status error (no raise)",
      res == {"status": "error", "risk": "medium", "error": "action_failed"}, res)
check("caller transaction still usable", alive == 42)
check("executor's partial write rolled back",
      one("SELECT COUNT(*) FROM portal_action_log WHERE action ="
          " 'should.vanish'")[0] == 0)
check("failure ledgered with reason",
      "downstream exploded" in (runs("action = 'test_boom'")[0][4] or ""))

# --- transient retry budget ------------------------------------------------------
class Serialization(Exception):
    pgcode = "40001"


calls = {"n": 0, "always": False}


def flaky(cur, client_id, args):
    calls["n"] += 1
    cur.execute("INSERT INTO portal_action_log (client_id, action) VALUES"
                " (1, 'flaky.try')")
    if calls["n"] == 1 or calls["always"]:
        raise Serialization("could not serialize access")
    return {"ok": True}


PA.ACTIONS["test_flaky"] = {"description": "t", "risk": "medium",
                            "required": [], "args": {}, "run": flaky}
res = ex("test_flaky", {})
check("serialization failure retried once", res["status"] == "executed"
      and calls["n"] == 2, (res, calls))
check("ledger counts attempts", runs("action = 'test_flaky'")[0][3] == 2)
check("first try's write rolled back, second kept",
      one("SELECT COUNT(*) FROM portal_action_log WHERE action ="
          " 'flaky.try'")[0] == 1)
calls.update(n=10, always=True)
PA.RETRIES = 1
res = ex("test_flaky", {})
check("retry budget is bounded (1 try + 1 retry)", res["status"] == "error"
      and calls["n"] == 12, (res, calls))

# --- statement timeout budget ----------------------------------------------------
PA.ACTIONS["test_slow"] = {"description": "t", "risk": "medium", "required": [],
                           "args": {}, "timeout_ms": 150,
                           "run": lambda cur, cid, a: cur.execute(
                               "SELECT pg_sleep(1)")}


def slow_then_show(cur):
    res = PA.execute(cur, 1, "o", "test_slow", {})
    cur.execute("SHOW statement_timeout")
    return res, cur.fetchall()[0][0]


res, after = run(slow_then_show)
check("slow action stopped by its budget", res["error"] == "timeout", res)
check("timeout ledgered", (runs("action = 'test_slow'")[0][4] or "")
      .startswith("timeout"))
check("session timeout restored after a timeout", after == "0", after)


def fast_then_show(cur):
    cur.execute("SET statement_timeout = '45s'")
    PA.execute(cur, 1, "o", "check_optout", {"contact_id": "x"})
    cur.execute("SHOW statement_timeout")
    return cur.fetchall()[0][0]


check("caller's own timeout restored after success",
      run(fast_then_show) == "45s")

# --- HIGH: approval once per key, ledgered -------------------------------------
high = dict(LINK, discount=300, conversation_id=CONV)
h1 = ex("create_checkout_link", high, idempotency_key="api:k3",
        conversation_id=CONV)
h2 = ex("create_checkout_link", high, idempotency_key="api:k3",
        conversation_id=CONV)
check("high -> approval_required", h1["status"] == "approval_required"
      and h1.get("approvalId"), h1)
check("repeat returns the same approval", h2.get("approvalId") == h1["approvalId"]
      and h2.get("replayed") is True, h2)
check("exactly one approval row",
      one("SELECT COUNT(*) FROM " + A.TABLE)[0] == 1)
check("ledger links the approval",
      runs("idempotency_key = 'api:k3'")[0][8] == h1["approvalId"])

# --- approval resolved twice -> action runs once -------------------------------
def load_approval(cur):
    cur.execute("SELECT * FROM " + A.TABLE + " WHERE id = %s",
                (h1["approvalId"],))
    return portal_db.rows(cur)[0]


approval = run(load_approval)
links_before = one("SELECT COUNT(*) FROM portal_checkout_links")[0]
r1 = run(lambda cur: PA.resolve_approval(cur, 1, approval, True))
r2 = run(lambda cur: PA.resolve_approval(cur, 1, approval, True))
check("approved action ran", r1["outcome"] == "executed", r1)
check("second resolve does not run it again",
      r2 == {"outcome": "executed", "detail": "Already ran for this approval."}, r2)
check("one discounted link created",
      one("SELECT COUNT(*) FROM portal_checkout_links")[0] == links_before + 1)

# --- agent denial ledgered -----------------------------------------------------
res = ex("create_checkout_link", dict(LINK), agent=deny)
check("denied ledgered", res["status"] == "denied"
      and runs("status = 'denied'")[-1][0] == "create_checkout_link")

# --- dry run writes nothing ----------------------------------------------------
before = one("SELECT COUNT(*) FROM portal_action_runs")[0]
res = ex("queue_whatsapp_message", msg, dry_run=True)
check("dry run: preview + zero writes", res["status"] == "preview"
      and one("SELECT COUNT(*) FROM portal_action_runs")[0] == before)

# --- workflow steps are keyed by run + step sequence -------------------------
run(WF._ensure_ddl)  # what run_due_workflows does before stepping
STEP = {"kind": "action", "step_no": 1,
        "config": {"action": "add_conversation_tag", "args": {"tag": "VIP"}}}
CTX = {"conversation_id": CONV, "contact_id": "923001112222@c.us"}
s1 = run(lambda cur: WF._execute_step(cur, 1, 4, {"id": 900, "_step_seq": 0},
                                      dict(STEP), dict(CTX)))
s2 = run(lambda cur: WF._execute_step(cur, 1, 4, {"id": 900, "_step_seq": 0},
                                      dict(STEP), dict(CTX)))
s3 = run(lambda cur: WF._execute_step(cur, 1, 4, {"id": 900, "_step_seq": 5},
                                      dict(STEP), dict(CTX)))
check("overlapping polls: same step outcome", s1["outcome"] == "executed"
      and s2["outcome"] == "executed", (s1, s2))
check("one ledger row per run step (loops get a new seq)",
      [r[2] for r in runs("action = 'add_conversation_tag'")]
      == ["wf:900:0", "wf:900:5"])
check("replayed step did not re-tag", s3["outcome"] == "executed"
      and one("SELECT COUNT(*) FROM " + portal_db.CONV_TAGS_TABLE)[0] == 1)

# --- retention sweep ------------------------------------------------------------
sql("INSERT INTO portal_action_runs (client_id, action, status, created_at)"
    " VALUES (1, 'old', 'executed', NOW() - INTERVAL '90 days')", fetch=False)
sql("SELECT setval('portal_action_runs_id_seq', 199)", fetch=True)
ex("check_optout", {"contact_id": "x"})
check("every 100th id prunes rows older than keepDays",
      one("SELECT COUNT(*) FROM portal_action_runs WHERE action = 'old'")[0] == 0)

# --- portal API -------------------------------------------------------------
OWNER = human_principal(client_id=1)
app = Flask("actions_v2_test")
for blueprint in (PA.bp, W.bp, portal_events.bp):
    app.register_blueprint(blueprint)
client = app.test_client()
stubs = [PrincipalStub(m, OWNER) for m in (PA, W, portal_events)]


def as_principal(principal):
    for stub in stubs:
        stub.principal = principal


J = {"Content-Type": "application/json"}
body = json.dumps({"action": "queue_whatsapp_message", "args": {
    "contact_id": "923001112222@c.us", "body": "API hello"}})
a1 = client.post("/api/v1/portal/actions/execute", data=body,
                 headers=dict(J, **{"Idempotency-Key": "order-77"}))
a2 = client.post("/api/v1/portal/actions/execute", data=body,
                 headers=dict(J, **{"Idempotency-Key": "order-77"}))
check("API: Idempotency-Key replays", a1.status_code == 200
      and a2.get_json().get("replayed") is True, a2.get_json())
check("API keys are namespaced", runs("idempotency_key = 'api:order-77'") != [])
bad = client.post("/api/v1/portal/actions/execute", data=body,
                  headers=dict(J, **{"Idempotency-Key": "two words"}))
check("API: unsafe key -> 400", bad.status_code == 400
      and bad.get_json()["error"]["code"] == "bad_idempotency_key")
inv = client.post("/api/v1/portal/actions/execute", headers=J, data=json.dumps(
    {"action": "request_refund", "args": {"conversation_id": "abc"}}))
check("API: invalid args -> 400 with fields", inv.status_code == 400
      and inv.get_json()["error"]["fields"] == ["conversation_id"], inv.get_json())
pv = client.post("/api/v1/portal/actions/preview", headers=J, data=json.dumps(
    {"action": "create_checkout_link", "args": dict(LINK, discount=10)}))
check("API: preview", pv.status_code == 200
      and pv.get_json()["wouldBe"] == "approval_required")
pv404 = client.post("/api/v1/portal/actions/preview", headers=J, data=json.dumps(
    {"action": "create_checkout_link", "args": LINK, "agent_id": 999}))
check("API: preview unknown agent -> 404", pv404.status_code == 404)
lst = client.get("/api/v1/portal/actions/runs?status=error").get_json()
check("API: runs filtered by status", lst["runs"]
      and all(r["status"] == "error" for r in lst["runs"]), lst["runs"][:1])
check("API: 7-day counts", lst["counts"]["executed"] >= 3
      and set(lst["counts"]) == set(PA.RUN_STATUSES), lst["counts"])
check("API: actor kind for workflows", any(
    r["actorKind"] == "workflow" for r in
    client.get("/api/v1/portal/actions/runs").get_json()["runs"]))
check("API: bad status -> 400",
      client.get("/api/v1/portal/actions/runs?status=zzz").status_code == 400)
as_principal(dict(OWNER, client_id=2))
check("API: workspace 2 sees no runs",
      client.get("/api/v1/portal/actions/runs").get_json()["runs"] == [])
as_principal(OWNER)
cat_api = client.get("/api/v1/portal/events/catalog")
check("API: event catalog", cat_api.status_code == 200
      and len(cat_api.get_json()["events"]) == len(EC.EVENTS))

# ---------------------------------------------------------------------------
# webhook outbox on real PostgreSQL
# ---------------------------------------------------------------------------
print("== webhook outbox ==")
# a pre-§225 install: old table shape, one 'all' endpoint, one delivery
sql("CREATE TABLE portal_webhooks (id BIGSERIAL PRIMARY KEY, client_id BIGINT"
    " NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL"
    " DEFAULT 'all', enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at"
    " TIMESTAMPTZ NOT NULL DEFAULT NOW())", fetch=False)
sql("CREATE TABLE portal_webhook_deliveries (id BIGSERIAL PRIMARY KEY,"
    " webhook_id BIGINT NOT NULL, client_id BIGINT NOT NULL, event TEXT NOT"
    " NULL, action_log_id BIGINT, payload JSONB NOT NULL DEFAULT '{}'::jsonb,"
    " status_code INT, error TEXT, attempts INT NOT NULL DEFAULT 0,"
    " next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at"
    " TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())", fetch=False)
LEGACY = one("INSERT INTO portal_webhooks (client_id, url, secret) VALUES"
             " (1, 'https://legacy.example/h', 's') RETURNING id")[0]
old_log = one("INSERT INTO portal_action_log (client_id, action, note) VALUES"
              " (1, 'cod.confirmed', 'old') RETURNING id")[0]
sql("INSERT INTO portal_webhook_deliveries (webhook_id, client_id, event,"
    " action_log_id, delivered_at) VALUES (%s, 1, 'cod', %s, NOW())",
    (LEGACY, old_log), fetch=False)
W._WEBHOOK_DDL_READY = False
_c = raw_conn()
try:
    W._ensure_webhook_tables(_c)
finally:
    _c.close()
legacy = one("SELECT events, last_log_id FROM portal_webhooks WHERE id = %s",
             (LEGACY,))
check("upgrade: legacy 'all' pinned to what it received", legacy[0] == "cod,broadcast")
check("upgrade: cursor after its last delivery", legacy[1] == old_log, legacy)
check("upgrade: dead_at column added", one(
    "SELECT COUNT(*) FROM information_schema.columns WHERE table_name ="
    " 'portal_webhook_deliveries' AND column_name = 'dead_at'")[0] == 1)
W._WEBHOOK_DDL_READY = False
_c = raw_conn()
try:
    W._ensure_webhook_tables(_c)  # idempotent second run
finally:
    _c.close()
check("upgrade is idempotent", one("SELECT events FROM portal_webhooks WHERE"
                                   " id = %s", (LEGACY,))[0] == "cod,broadcast")

posts = []


class Ok:
    status = 200


def ok_post(url, headers, body, timeout=5):
    posts.append((url, headers.get("X-Omniflow-Event"), json.loads(body)))
    return Ok()


def down(url, headers, body, timeout=5):
    raise OSError("connection refused")


def poll():
    c = portal_db._conn()
    try:
        with c.cursor() as cur:
            return W.deliver_pending_webhooks(cur, 1, c)
    finally:
        c.close()


def log_event(action, note="n"):
    return one("INSERT INTO portal_action_log (client_id, action, note)"
               " VALUES (1, %s, %s) RETURNING id", (action, note))[0]


# starvation: 30 cod events ahead of one broadcast
for i in range(30):
    log_event("cod.confirmed", "cod " + str(i))
bcast = log_event("broadcast.sent", "Eid sale")
sql("UPDATE portal_webhooks SET events = 'broadcast' WHERE id = %s", (LEGACY,),
    fetch=False)
W._http_post = ok_post
poll()
check("broadcast delivered on the first poll (no starvation)",
      [p[2]["data"]["action"] for p in posts] == ["broadcast.sent"], posts)
check("cursor jumped to the broadcast", one(
    "SELECT last_log_id FROM portal_webhooks WHERE id = %s", (LEGACY,))[0] == bcast)

# a new endpoint via the API starts at the end of the outbox
end_of_log = one("SELECT MAX(id) FROM portal_action_log")[0]
r = client.post("/api/v1/portal/webhooks", headers=J, data=json.dumps(
    {"url": "https://new.example/h", "events": "payments,cod"}))
NEW = r.get_json()["webhook"]["id"]
check("API: create with catalog categories", r.status_code == 200
      and r.get_json()["webhook"]["events"] == "payments,cod")
check("new endpoint gets no history", one(
    "SELECT last_log_id FROM portal_webhooks WHERE id = %s", (NEW,))[0]
    == end_of_log)
bad_ev = client.post("/api/v1/portal/webhooks", headers=J, data=json.dumps(
    {"url": "https://x.example/h", "events": "weird"}))
check("API: unknown category -> 400 listing categories",
      bad_ev.status_code == 400 and "payments" in bad_ev.get_json()["error"]["message"])
posts.clear()
paid = log_event("payment.gateway_paid", "Link abc paid 4500")
poll()
check("payments event reaches the new endpoint with its category",
      [(p[0], p[1], p[2]["data"]["action"]) for p in posts]
      == [("https://new.example/h", "payments", "payment.gateway_paid")], posts)

# dead letters
W._http_post = down
log_event("cod.declined", "declined")
sql("UPDATE portal_webhooks SET enabled = FALSE WHERE id = %s", (LEGACY,),
    fetch=False)
poll()
dlv = one("SELECT id, attempts FROM portal_webhook_deliveries WHERE webhook_id"
          " = %s AND delivered_at IS NULL", (NEW,))
check("failure scheduled a retry", dlv[1] == 1)
sql("UPDATE portal_webhook_deliveries SET attempts = %s, next_attempt_at ="
    " NOW() WHERE id = %s", (W.MAX_ATTEMPTS - 1, dlv[0]), fetch=False)
notified.clear()
poll()
check("last attempt -> dead letter", one(
    "SELECT dead_at IS NOT NULL, attempts FROM portal_webhook_deliveries"
    " WHERE id = %s", (dlv[0],)) == (True, W.MAX_ATTEMPTS))
check("owner notified once", len(notified) == 1
      and notified[0][0][1] == "delivery", notified)
poll()
check("dead letters are not retried", len(notified) == 1 and one(
    "SELECT attempts FROM portal_webhook_deliveries WHERE id = %s",
    (dlv[0],))[0] == W.MAX_ATTEMPTS)
hooks = {h["id"]: h for h in client.get("/api/v1/portal/webhooks")
         .get_json()["webhooks"]}
check("API: dead count per endpoint", hooks[NEW]["dead_count"] == 1, hooks[NEW])
dl = client.get("/api/v1/portal/webhooks/" + str(NEW) + "/deliveries").get_json()
check("API: delivery flagged dead", any(d["dead"] for d in dl["deliveries"]))
W._http_post = ok_post
rp = client.post("/api/v1/portal/webhooks/" + str(NEW) + "/deliveries/replay-dead")
check("API: replay dead -> requeued", rp.status_code == 200
      and rp.get_json()["replayed"] == 1, rp.get_json())
posts.clear()
poll()
check("replayed letter delivered", one(
    "SELECT delivered_at IS NOT NULL FROM portal_webhook_deliveries WHERE"
    " id = %s", (dlv[0],))[0] is True and len(posts) == 1)
check("replay audited", one("SELECT COUNT(*) FROM portal_action_log WHERE"
                            " action = 'webhooks.replayed'")[0] == 1)
as_principal(dict(OWNER, client_id=2))
check("API: other workspace cannot replay",
      client.post("/api/v1/portal/webhooks/" + str(NEW)
                  + "/deliveries/replay-dead").status_code == 404)
as_principal(OWNER)

# enable/disable is committed; re-enable skips the backlog
r = client.put("/api/v1/portal/webhooks/" + str(NEW), headers=J,
               data=json.dumps({"enabled": False}))
check("disable is persisted (commit fix)", r.status_code == 200 and one(
    "SELECT enabled FROM portal_webhooks WHERE id = %s", (NEW,))[0] is False)
log_event("cod.confirmed", "while off")
r = client.put("/api/v1/portal/webhooks/" + str(NEW), headers=J,
               data=json.dumps({"enabled": True}))
check("re-enable resumes from now", one(
    "SELECT enabled, last_log_id FROM portal_webhooks WHERE id = %s", (NEW,))
    == (True, one("SELECT MAX(id) FROM portal_action_log")[0]))
posts.clear()
poll()
check("no backlog delivered after re-enable", posts == [], posts)

# --- cold start: existing ledger -> probe only, no DDL in the caller's tx ----
PA._RUNS_DDL_READY = False
seen = []


class Spy:
    def __init__(self, cur):
        self.cur = cur

    def execute(self, query, params=None):
        seen.append(query)
        return self.cur.execute(query, params)

    def __getattr__(self, name):
        return getattr(self.cur, name)


run(lambda cur: PA._ensure_runs_ddl(Spy(cur)))
check("cold start with an existing ledger runs no DDL",
      len(seen) == 1 and "to_regclass" in seen[0], seen)
sql("DROP TABLE portal_action_runs", fetch=False)
PA._RUNS_DDL_READY = False
ex("check_optout", {"contact_id": "x"})
check("missing ledger is created on first use",
      one("SELECT COUNT(*) FROM portal_action_runs")[0] == 1
      and one("SELECT COUNT(*) FROM pg_indexes WHERE indexname ="
              " 'uq_portal_action_runs_key'")[0] == 1)

for stub in stubs:
    stub.restore()
server.cleanup()
summary("actions_v2")
