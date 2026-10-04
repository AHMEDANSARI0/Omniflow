"""§224 Approvals v2 + config snapshots - real PostgreSQL flow.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
Uses `pgserver` (a real PostgreSQL 16); skipped (with a note) when it is
not installed. Unit helpers are covered here too (no database needed).
"""
import json
import os
import sys

from test_lib import check, summary, human_principal, PrincipalStub

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")

# ---------------------------------------------------------------------------
# unit: kinds, risk, edits (pure helpers)
# ---------------------------------------------------------------------------
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
import portal_approvals as A  # noqa: E402
import portal_snapshots as S  # noqa: E402

print("== approvals v2 helpers ==")
legacy = {"source": "ai", "action": "refund", "context_json": {}}
check("legacy keyword row -> customer_request",
      A.kind_of(legacy) == "customer_request" and A.risk_of(legacy) == "high")
check("workflow row -> workflow_step",
      A.kind_of({"source": "workflow", "action": "workflow_step"})
      == "workflow_step")
link = {"source": "agent", "action": "create_checkout_link", "status": "pending",
        "context_json": {"action": "create_checkout_link", "args": {
            "contact_id": "923001112222@c.us", "conversation_id": 5,
            "_actor": "agent:7", "title": "Lawn suit",
            "discount": 500, "items": [{"name": "Lawn", "qty": 2,
                                        "price": 3000}]}}}
check("agent row -> action, discount makes it high",
      A.kind_of(link) == "action" and A.risk_of(link) == "high")
money = A.impact_of(link)["money"]
check("impact money from args", money == {"subtotal": 6000.0,
                                          "discount": 500.0, "total": 5500.0},
      money)
fields = {f["key"]: f for f in A.editable_fields(link)}
check("editable: title/discount/items; ids + _actor locked",
      sorted(fields) == ["discount", "items", "title"], sorted(fields))
check("items columns typed", fields["items"]["columns"] == [
    {"key": "name", "type": "text"}, {"key": "qty", "type": "number"},
    {"key": "price", "type": "number"}], fields["items"])
cleaned = A.apply_edits(link, {"discount": "250", "title": "Lawn suit"})
check("edits: only changed keys, number coerced", cleaned == {"discount": 250},
      cleaned)
for bad, why in (({"contact_id": "x"}, "locked id"),
                 ({"_actor": "me"}, "internal"),
                 ({"discount": "lots"}, "type"),
                 ({"items": []}, "empty list"),
                 ({"items": [{"name": "A", "qty": 1, "price": 1, "sku": "z"}]},
                  "new key"),
                 ({"items": [{"name": "A", "qty": 1, "price": 1}] * 2},
                  "more rows than original"),
                 ({"brand_new": 1}, "unknown key"),
                 ("discount=1", "not an object")):
    try:
        A.apply_edits(link, bad)
        check("edit rejected: " + why, False)
    except ValueError:
        check("edit rejected: " + why, True)
check("non-action rows cannot be edited",
      A.editable_fields(legacy) == [])
check("decided rows are not editable",
      A.editable_fields(dict(link, status="approved")) == [])
check("secret names never snapshotted",
      all(S._secret(n) for n in ("api_key", "webhook_secret", "auth_token",
                                 "smtp_password", "private_key"))
      and not any(S._secret(n) for n in ("tone", "greeting", "autonomy",
                                         "agent_name", "approval_number")))
check("plain() drops nested secrets",
      S._plain({"a": 1, "nested": {"api_key": "x", "b": 2}})
      == {"a": 1, "nested": {"b": 2}})

# ---------------------------------------------------------------------------
# website pins (read from the repo root = parent of the CP folder)
# ---------------------------------------------------------------------------
print("== website pins ==")
ROOT = os.path.dirname(os.getcwd()) + "/"


def web(path):
    with open(ROOT + path, encoding="utf8") as handle:
        return handle.read()


PORTAL = web("lib/omniflow/portal.ts")
check("portalRequest sends JSON Content-Type for string bodies (bugs 6+7)",
      'typeof init.body === "string" && !headers.has("Content-Type")'
      in PORTAL and 'headers.set("Content-Type", "application/json")'
      in PORTAL)
check("mapApproval reads camelCase and snake_case (bug 4)",
      'pickKey(row, "contactId", "contact_id")' in PORTAL
      and 'pickKey(row, "refCode", "ref_code")' in PORTAL)
service = PORTAL[PORTAL.index("async function serviceResult<T>"):]
service = service[:service.index("\n}\n")]
check("serviceResult passes 403 through", "response.status === 403" in service)
for name in ("getApproval", "decideApproval", "retryApproval",
             "listConfigSnapshots", "createConfigSnapshot",
             "getConfigSnapshot", "restoreConfigSnapshot",
             "deleteConfigSnapshot"):
    check("portal.ts exports " + name, "function " + name + "(" in PORTAL)
for route in ("approvals/[id]/route.ts", "approvals/[id]/decide/route.ts",
              "approvals/[id]/retry/route.ts", "snapshots/route.ts",
              "snapshots/[id]/route.ts", "snapshots/[id]/restore/route.ts"):
    src = web("app/api/omniflow/portal/" + route)
    check("BFF " + route + " uses the shared helpers",
          "withPortalToken" in src)
    if "POST" in src or "DELETE" in src:
        check("BFF " + route + " checks the origin on writes",
              "}, request);" in src or "request\n  );" in src)
restore_src = web("app/api/omniflow/portal/snapshots/[id]/restore/route.ts")
check("empty areas never become a full restore",
      "restoreConfigSnapshot(accessToken, id, areas)" in restore_src)
page = web("app/dashboard/(portal)/approvals/page.tsx")
panel = web("app/dashboard/(portal)/approvals/ApprovalPanel.tsx")
check("approvals page: panel + retry + kind filter",
      "<ApprovalPanel" in page and "/retry" in page and "&kind=" in page)
check("panel: impact, evidence, edits, reply, note",
      "If you approve" in panel and "recentMessages" in panel
      and "Approve with changes" in panel and "Reply to the customer" in panel
      and "Internal note" in panel)
settings = web("app/dashboard/(portal)/settings/page.tsx")
check("settings shows ConfigHistoryCard after DataSafetyCard",
      settings.index("<ConfigHistoryCard />")
      > settings.index("<DataSafetyCard />"))
for path, src in (("page", page), ("panel", panel),
                  ("history", web("app/dashboard/(portal)/settings/"
                                  "ConfigHistoryCard.tsx"))):
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
    summary("approvals_v2")
    sys.exit(0)

print("== approvals v2 on real PostgreSQL ==")
import importlib  # noqa: E402
import tempfile  # noqa: E402

data_dir = tempfile.mkdtemp(prefix="of_appr_pg_")
server = pgserver.get_server(data_dir, cleanup_mode="stop")
os.environ.update({"DB_HOST": data_dir, "DB_PORT": "5432",
                   "DB_NAME": "postgres", "DB_USER": "postgres",
                   "DB_PASSWORD": "", "PGSSLMODE": "disable"})
import portal_db  # noqa: E402

check("real portal_db in use",
      os.path.dirname(os.path.abspath(portal_db.__file__)) == os.getcwd())
for name in ("portal_approvals", "portal_snapshots", "portal_actions",
             "portal_bot", "portal_profile", "portal_brain",
             "portal_checkout"):
    if name in sys.modules:
        importlib.reload(sys.modules[name])
import portal_approvals as A  # noqa: E402,F811
import portal_snapshots as S  # noqa: E402,F811
import portal_actions  # noqa: E402
import portal_bot  # noqa: E402
import portal_brain  # noqa: E402
import portal_checkout  # noqa: E402
from flask import Flask  # noqa: E402


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


portal_db.ensure_tables()
# main-app schema tables the mirror does not create
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
    with _c.cursor() as _cur:
        portal_brain._ensure_ddl(_cur)
    _c.commit()
finally:
    _c.close()
# notifications are another module's job; keep this test self-contained
sys.modules["portal_notify"] = type(sys)("portal_notify")
sys.modules["portal_notify"].notify = lambda *a, **k: None

OWNER = human_principal(client_id=1)
app = Flask("approvals_v2_test")
import portal_profile  # noqa: E402

for blueprint in (A.bp, S.bp, portal_bot.bp, portal_brain.bp,
                  portal_profile.bp):
    app.register_blueprint(blueprint)
client = app.test_client()
stubs = [PrincipalStub(m, OWNER)
         for m in (A, S, portal_bot, portal_brain, portal_profile)]


def as_principal(principal):
    for stub in stubs:
        stub.principal = principal


def one(query, params=None):
    rows = sql(query, params)
    return rows[0] if rows else None


def make(action, args, contact="923001112222@c.us", conv=5):
    """An Action Engine HIGH-risk call -> pending approval id."""
    c = portal_db._conn()
    try:
        with c.cursor() as cur:
            out = portal_actions.execute(cur, 1, "agent:7", action,
                                         dict(args, contact_id=contact,
                                              conversation_id=conv),
                                         conversation_id=conv)
        c.commit()
    finally:
        c.close()
    return out


def cmds(source="approval"):
    return [json.loads(r[0]) if isinstance(r[0], str) else r[0]
            for r in sql("SELECT payload FROM portal_connector_commands"
                         " ORDER BY id")
            if (r[0] if isinstance(r[0], dict) else json.loads(r[0]))
            .get("source") == source]


URL = "/api/v1/portal/approvals"
J = {"Content-Type": "application/json"}

# --- create: kind/risk stored, owner gets a money line --------------------
sql("INSERT INTO portal_whatsapp_status (client_id, phone) VALUES (1,"
    " '923331234567') ON CONFLICT DO NOTHING", fetch=False) \
    if one("SELECT to_regclass('portal_whatsapp_status')")[0] else None
out = make("create_checkout_link", {"title": "Lawn suit", "discount": 500,
                                    "items": [{"name": "Lawn", "qty": 2,
                                               "price": 3000}]})
check("HIGH action -> approval_required", out.get("status")
      == "approval_required", out)
link_id = out.get("approvalId")
row = one("SELECT kind, risk, status FROM portal_approvals WHERE id = %s",
          (link_id,))
check("kind + risk columns stored", row == ("action", "high", "pending"), row)
owner_msg = [c for c in cmds() if "Approval" in c.get("body", "")]
check("owner notified with a money line",
      owner_msg and "Raqam:" in owner_msg[-1]["body"]
      and "5,500" in owner_msg[-1]["body"], owner_msg[-1:] or "none")

# --- list + detail ----------------------------------------------------------
r = client.get(URL + "?status=pending")
items = r.get_json().get("approvals", [])
check("list 200 with v2 fields", r.status_code == 200 and items
      and items[0]["kind"] == "action" and items[0]["risk"] == "high"
      and items[0]["impact"]["money"]["total"] == 5500.0, r.get_json())
check("list returns kind filters",
      [k["key"] for k in r.get_json()["kinds"]][:2] == ["action",
                                                        "workflow_step"])
r = client.get(URL + "?kind=workflow_step")
check("kind filter narrows", r.get_json()["approvals"] == [])
sql("INSERT INTO portal_messages (client_id, conversation_id, direction,"
    " body) VALUES (1, 5, 'in', 'Discount mil sakta hai?')", fetch=False) \
    if one("SELECT 1 FROM information_schema.columns WHERE table_name ="
           " 'portal_messages' AND column_name = 'conversation_id'") else None
sql("INSERT INTO portal_brain_facts (client_id, kind, label, content)"
    " VALUES (1, 'pricing', 'Max discount', %s)", ("Never more than 10%",),
    fetch=False)
r = client.get(URL + "/" + str(link_id))
detail = r.get_json().get("approval", {})
check("detail 200 + canDecide for owner", r.status_code == 200
      and detail.get("canDecide") is True, r.get_json())
check("detail editable fields",
      sorted(f["key"] for f in detail.get("editable", []))
      == ["discount", "items", "title"], detail.get("editable"))
evidence = detail.get("evidence", {})
check("evidence: trigger + pricing policy",
      evidence.get("trigger", {}).get("source") == "agent"
      and any(p["label"] == "Max discount"
              for p in evidence.get("policies", [])), evidence)
check("evidence never breaks on missing tables (orders/notes)",
      r.status_code == 200)
r = client.get(URL + "/999999")
check("detail unknown -> 404", r.status_code == 404)

# --- bug 5: decide needs a human owner/admin --------------------------------
as_principal(dict(OWNER, role="member"))
r = client.post(URL + "/" + str(link_id) + "/decide", headers=J,
                data=json.dumps({"decision": "approve"}))
check("member cannot decide (403)", r.status_code == 403, r.status_code)
as_principal(dict(OWNER, via_api_key=True))
r = client.post(URL + "/" + str(link_id) + "/decide", headers=J,
                data=json.dumps({"decision": "approve"}))
check("API key cannot decide (403)", r.status_code == 403, r.status_code)
as_principal(OWNER)
check("still pending after refusals",
      one("SELECT status FROM portal_approvals WHERE id = %s",
          (link_id,))[0] == "pending")

# --- validation -------------------------------------------------------------
r = client.post(URL + "/" + str(link_id) + "/decide", headers=J,
                data=json.dumps({"decision": "maybe"}))
check("bad decision -> 400", r.status_code == 400)
r = client.post(URL + "/" + str(link_id) + "/decide", headers=J,
                data=json.dumps({"decision": "approve",
                                 "args": {"contact_id": "92300999"}}))
check("editing a locked field -> 400", r.status_code == 400
      and "cannot be edited" in r.get_json()["error"]["message"])
check("400 left it pending",
      one("SELECT status FROM portal_approvals WHERE id = %s",
          (link_id,))[0] == "pending")

# --- bugs 1+2: approve with edits really runs and is committed -------------
r = client.post(URL + "/" + str(link_id) + "/decide", headers=J,
                data=json.dumps({"decision": "approve", "note": "ok at 250",
                                 "args": {"discount": 250}}))
res = r.get_json()
check("approve 200 executed", r.status_code == 200
      and res.get("outcome") == "executed", res)
row = one("SELECT status, decided_via, decision_note, outcome,"
          " edits_json FROM portal_approvals WHERE id = %s", (link_id,))
check("decision committed (new connection sees it)",
      row[0] == "approved" and row[1] == "portal" and row[2] == "ok at 250"
      and row[3] == "executed", row)
check("edits stored", row[4] == {"args": {"discount": 250}}, row[4])
link_row = one("SELECT discount, total FROM portal_checkout_links"
               " ORDER BY id DESC LIMIT 1")
check("action ran with the owner's edit",
      link_row and float(link_row[0]) == 250.0
      and float(link_row[1]) == 5750.0, link_row)
audit = [r[0] for r in sql("SELECT action FROM portal_action_log"
                           " ORDER BY id")]
check("audit: edited + approved + action run",
      "approval.edited" in audit and "approval.approved" in audit
      and "action.create_checkout_link.approved" in audit, audit)
r = client.post(URL + "/" + str(link_id) + "/decide", headers=J,
                data=json.dumps({"decision": "reject"}))
check("second decision -> 409", r.status_code == 409)
check("only one checkout link created",
      one("SELECT COUNT(*) FROM portal_checkout_links")[0] == 1)

# --- failure keeps the decision; retry after the fix -----------------------
sql("DROP TABLE IF EXISTS portal_action_requests", fetch=False)
out = make("request_refund", {"note": "kapra phata hua"},
           contact="923004445555@c.us", conv=6)
refund_id = out.get("approvalId")
r = client.post(URL + "/" + str(refund_id) + "/decide", headers=J,
                data=json.dumps({"decision": "approve",
                                 "reply": "Refund approve ho gaya."}))
res = r.get_json()
check("approve with failing action -> 200 outcome failed",
      r.status_code == 200 and res.get("outcome") == "failed"
      and "portal_action_requests" in res.get("outcomeDetail", ""), res)
row = one("SELECT status, outcome FROM portal_approvals WHERE id = %s",
          (refund_id,))
check("decision kept even though the action failed",
      row == ("approved", "failed"), row)
check("no customer reply on failure",
      not [c for c in cmds() if c.get("body") == "Refund approve ho gaya."])
r = client.post(URL + "/" + str(link_id) + "/retry")
check("retry refused for a success (409)", r.status_code == 409)
sql("CREATE TABLE portal_action_requests (id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT, conversation_id BIGINT, contact_id TEXT, kind TEXT,"
    " note TEXT, status TEXT, created_at TIMESTAMPTZ, updated_at"
    " TIMESTAMPTZ)", fetch=False)
r = client.post(URL + "/" + str(refund_id) + "/retry")
res = r.get_json()
check("retry 200 executed", r.status_code == 200
      and res.get("outcome") == "executed", res)
check("refund request landed as done",
      one("SELECT status FROM portal_action_requests")[0] == "done")
check("stored reply queued on success",
      [c for c in cmds() if c.get("body") == "Refund approve ho gaya."
       and c.get("external_user_id") == "923004445555@c.us"])
r = client.post(URL + "/" + str(refund_id) + "/retry")
check("retry twice refused (409)", r.status_code == 409)
check("audit approval.retried",
      one("SELECT COUNT(*) FROM portal_action_log WHERE action ="
          " 'approval.retried'")[0] == 1)

# --- reject with an owner reply replaces the stock hold --------------------
out = make("request_order_cancel", {}, contact="923006667777@c.us", conv=7)
cancel_id = out.get("approvalId")
r = client.post(URL + "/" + str(cancel_id) + "/decide", headers=J,
                data=json.dumps({"decision": "reject",
                                 "reply": "Order dispatch ho chuka hai."}))
check("reject 200 reply_sent", r.status_code == 200
      and r.get_json().get("outcome") == "reply_sent", r.get_json())
sent = [c for c in cmds() if c.get("external_user_id")
        == "923006667777@c.us"]
check("exactly the owner's reply went out (no stock hold)",
      [c["body"] for c in sent] == ["Order dispatch ho chuka hai."],
      [c["body"] for c in sent])
check("reject runs nothing",
      one("SELECT COUNT(*) FROM portal_action_requests")[0] == 1)

# --- legacy customer_request + opt-out guard -------------------------------
c = portal_db._conn()
try:
    with c.cursor() as cur:
        made = A.create_approval(cur, 1, 8, "923008889999@c.us", "Sara",
                                 "refund", "Refund maanga", "paisay wapis")
    c.commit()
finally:
    c.close()
check("legacy create -> customer_request kind",
      made and made["kind"] == "customer_request", made)
sql("INSERT INTO portal_optouts VALUES (1, '923008889999@c.us')", fetch=False)
r = client.post(URL + "/" + str(made["id"]) + "/decide", headers=J,
                data=json.dumps({"decision": "approve",
                                 "reply": "Theek hai"}))
res = r.get_json()
check("opted-out customer: decision ok, reply not sent",
      r.status_code == 200 and res.get("outcome") == "recorded"
      and "opted out" in res.get("outcomeDetail", ""), res)
check("already-decided legacy row -> 409",
      client.post(URL + "/" + str(made["id"]) + "/decide", headers=J,
                  data=json.dumps({"decision": "approve",
                                   "args": {"x": 1}})).status_code == 409)

# --- bug 3: list expiry is committed; expired cannot be decided ------------
c = portal_db._conn()
try:
    with c.cursor() as cur:
        old = A.create_approval(cur, 1, 9, "923001010101@c.us", None,
                                "discount", "Discount", "discount do")
    c.commit()
finally:
    c.close()
sql("UPDATE portal_approvals SET expires_at = NOW() - INTERVAL '1 hour'"
    " WHERE id = %s", (old["id"],), fetch=False)
r = client.post(URL + "/" + str(old["id"]) + "/decide", headers=J,
                data=json.dumps({"decision": "approve"}))
check("expired (not yet swept) -> 409", r.status_code == 409
      and "expired" in r.get_json()["error"]["message"], r.get_json())
client.get(URL + "?status=all")
check("list expiry committed",
      one("SELECT status FROM portal_approvals WHERE id = %s",
          (old["id"],))[0] == "expired")

# --- WhatsApp 1/0 path still works and records an outcome ------------------
out = make("create_checkout_link", {"title": "Kurta", "discount": 100,
                                    "items": [{"name": "Kurta", "qty": 1,
                                               "price": 2000}]},
           contact="923002020202@c.us", conv=10)
wa_id = out.get("approvalId")
c = portal_db._conn()
try:
    claimed = A.maybe_decide(1, None, "923331234567@c.us", "1", "in", c)
    c.commit()
finally:
    c.close()
row = one("SELECT status, decided_via, outcome FROM portal_approvals"
          " WHERE id = %s", (wa_id,))
check("WhatsApp 1 approves + runs", claimed
      and row == ("approved", "whatsapp", "executed"), (claimed, row))

# --- approvals config: unparsed body never wipes the number ----------------
r = client.put(URL + "/config", headers=J,
               data=json.dumps({"approvalNumber": "923331234567",
                                "autoExpireHours": 12}))
check("config put 200", r.status_code == 200, r.get_json())
r = client.put(URL + "/config", data=json.dumps({"approvalNumber": ""}),
               content_type="text/plain")
check("text/plain body -> 400", r.status_code == 400, r.status_code)
check("number survived",
      one("SELECT approval_number FROM portal_approvals_config"
          " WHERE client_id = 1")[0] == "923331234567")

# ---------------------------------------------------------------------------
# config snapshots
# ---------------------------------------------------------------------------
print("== config snapshots on real PostgreSQL ==")
SNAP = "/api/v1/portal/snapshots"
sql("DELETE FROM portal_config_snapshots", fetch=False)
sql("CREATE TABLE IF NOT EXISTS client_settings (client_id BIGINT PRIMARY"
    " KEY, settings JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at"
    " TIMESTAMPTZ NOT NULL DEFAULT NOW())", fetch=False)
sql("INSERT INTO client_settings (client_id, settings) VALUES (1, %s)",
    (json.dumps({"currency": "PKR", "llm_api_key": "sk-live-secret"}),),
    fetch=False)
r = client.put("/api/v1/portal/bot", headers=J, data=json.dumps({
    "agent_name": "Ayesha", "tone": "friendly", "greeting": "Salam!",
    "fallback": ""}))
check("bot save 200", r.status_code == 200, r.get_json())
autos = sql("SELECT id, reason, label FROM portal_config_snapshots")
check("first save took an automatic snapshot",
      len(autos) == 1 and autos[0][1] == "auto"
      and autos[0][2] == "Before bot settings change", autos)
client.put("/api/v1/portal/brain/settings", headers=J,
           data=json.dumps({"autonomy": "auto", "tone": "warm"}))
check("second save within the window: grouped (no new snapshot)",
      one("SELECT COUNT(*) FROM portal_config_snapshots")[0] == 1)

r = client.put("/api/v1/portal/profile", headers=J, data=json.dumps({
    "profile": {"business_name": "Ayesha Lawn",
                "wa": {"number": "923331234567", "api_key": "k-old"}}}))
check("profile save 200", r.status_code == 200, r.get_json())
r = client.post(SNAP, headers=J, data=json.dumps({"label": "Good setup"}))
good = r.get_json().get("snapshot", {})
check("manual snapshot 200", r.status_code == 200 and good.get("id"),
      r.get_json())
data = one("SELECT data FROM portal_config_snapshots WHERE id = %s",
           (good["id"],))[0]
check("snapshot areas captured",
      {"bot", "profile", "brain", "brain_facts", "workspace", "approvals"}
      <= set(data), sorted(data))
check("bot row captured", data["bot"]["row"]["agent_name"] == "Ayesha")
check("secret setting never stored",
      "llm_api_key" not in json.dumps(data)
      and data["workspace"]["row"]["settings"] == {"currency": "PKR"},
      data["workspace"])
r = client.get(SNAP)
listed = r.get_json()
check("list 200 + areas + canRestore", r.status_code == 200
      and listed["snapshots"][0]["id"] == good["id"]
      and "bot" in listed["snapshots"][0]["areas"]
      and listed["canRestore"] is True, listed)

# make changes after the good snapshot
client.put("/api/v1/portal/bot", headers=J, data=json.dumps({
    "agent_name": "Broken Bot", "tone": "concise", "greeting": "",
    "fallback": ""}))
client.put("/api/v1/portal/brain/settings", headers=J,
           data=json.dumps({"autonomy": "off", "tone": ""}))
fact_ids = [r[0] for r in sql("SELECT id FROM portal_brain_facts"
                              " ORDER BY id")]
client.post("/api/v1/portal/brain/facts", headers=J, data=json.dumps({
    "id": fact_ids[0], "kind": "pricing", "label": "Max discount",
    "content": "Up to 50%"}))
client.post("/api/v1/portal/brain/facts", headers=J, data=json.dumps({
    "kind": "policy", "label": "Added later", "content": "New rule"}))
client.put("/api/v1/portal/profile", headers=J, data=json.dumps({
    "profile": {"business_name": "Wrong Name", "extra": 1,
                "wa": {"number": "920000000000", "api_key": "k-new"}}}))
sql("UPDATE client_settings SET settings = %s WHERE client_id = 1",
    (json.dumps({"currency": "USD", "new_flag": True,
                 "llm_api_key": "sk-rotated"}),), fetch=False)

r = client.get(SNAP + "/" + str(good["id"]))
compare = {a["key"]: a for a in r.get_json()["snapshot"]["compare"]}
check("compare shows bot change",
      any(c["field"] == "agent_name" and c["current"] == "Broken Bot"
          and c["snapshot"] == "Ayesha" for c in compare["bot"]["changes"]),
      compare["bot"])
check("compare shows fact edit + later fact archived",
      any(c["field"] == "Max discount" for c in
          compare["brain_facts"]["changes"])
      and any(c["snapshot"] == "archived" for c in
              compare["brain_facts"]["changes"]),
      compare["brain_facts"])
check("compare settings: currency only (secret hidden)",
      [c["field"] for c in compare["workspace"]["changes"]]
      == ["settings.currency"], compare["workspace"])

# --- restore permissions + validation ---------------------------------------
as_principal(dict(OWNER, role="member"))
check("member cannot restore (403)",
      client.post(SNAP + "/" + str(good["id"]) + "/restore", headers=J,
                  data="{}").status_code == 403)
as_principal(OWNER)
check("unknown area -> 400",
      client.post(SNAP + "/" + str(good["id"]) + "/restore", headers=J,
                  data=json.dumps({"areas": ["bot", "nope"]})).status_code
      == 400)
check("unknown snapshot -> 404",
      client.post(SNAP + "/999999/restore", headers=J,
                  data="{}").status_code == 404)

# --- partial restore (bot only) ---------------------------------------------
r = client.post(SNAP + "/" + str(good["id"]) + "/restore", headers=J,
                data=json.dumps({"areas": ["bot"]}))
res = r.get_json()
check("restore bot 200 + backup", r.status_code == 200
      and res.get("backupId") and [a["key"] for a in res["areas"]] == ["bot"],
      res)
check("bot restored",
      one("SELECT agent_name, tone FROM portal_bot_configs WHERE client_id"
          " = 1") == ("Ayesha", "friendly"))
check("brain untouched by a bot-only restore",
      one("SELECT autonomy FROM portal_brain_settings WHERE client_id = 1")[0]
      == "off")

# --- full restore -----------------------------------------------------------
r = client.post(SNAP + "/" + str(good["id"]) + "/restore", headers=J,
                data="{}")
res = r.get_json()
check("full restore 200", r.status_code == 200, res)
check("brain settings restored",
      one("SELECT autonomy, tone FROM portal_brain_settings WHERE client_id"
          " = 1") == ("auto", "warm"))
profile = one("SELECT profile FROM portal_profiles WHERE client_id = 1")[0]
check("profile restored; nested live secret kept; later key removed",
      profile == {"business_name": "Ayesha Lawn",
                  "wa": {"number": "923331234567", "api_key": "k-new"}},
      profile)
facts = {r[0]: (r[1], r[2]) for r in sql(
    "SELECT label, content, is_active FROM portal_brain_facts")}
check("edited fact restored", facts["Max discount"]
      == ("Never more than 10%", True), facts)
check("fact added later archived, not deleted",
      facts.get("Added later") == ("New rule", False), facts)
settings = one("SELECT settings FROM client_settings WHERE client_id = 1")[0]
check("settings: value restored, later key kept, live secret untouched",
      settings == {"currency": "PKR", "new_flag": True,
                   "llm_api_key": "sk-rotated"}, settings)
facts_report = next(a for a in res["areas"] if a["key"] == "brain_facts")
check("facts report counts", facts_report.get("changed") == 1
      and facts_report.get("archived") == 1, facts_report)
check("audit config.restored x2",
      one("SELECT COUNT(*) FROM portal_action_log WHERE action ="
          " 'config.restored'")[0] == 2)

# --- a restore can be undone with its backup ---------------------------------
r = client.post(SNAP + "/" + str(res["backupId"]) + "/restore", headers=J,
                data="{}")
check("undo restore via backup",
      r.status_code == 200
      and one("SELECT autonomy FROM portal_brain_settings WHERE client_id"
              " = 1")[0] == "off")

# --- throttle window + dedupe -------------------------------------------------
sql("UPDATE portal_config_snapshots SET created_at = NOW() - INTERVAL"
    " '2 hours'", fetch=False)
before = one("SELECT COUNT(*) FROM portal_config_snapshots")[0]
c = portal_db._conn()
try:
    with c.cursor() as cur:
        S.take(cur, 1, "auto", "baseline")
        cur.execute("UPDATE portal_config_snapshots SET created_at = NOW()"
                    " - INTERVAL '2 hours'")
        same = S.before_change(cur, 1, "bot")
    c.commit()
finally:
    c.close()
check("nothing changed since the last snapshot: no duplicate",
      same is None
      and one("SELECT COUNT(*) FROM portal_config_snapshots")[0]
      == before + 1)

# --- prune keeps manual ones ---------------------------------------------------
os.environ["OF_SNAPSHOT_KEEP"] = "2"
c = portal_db._conn()
try:
    with c.cursor() as cur:
        for n in range(4):
            S.take(cur, 1, "auto", "auto " + str(n))
    c.commit()
finally:
    c.close()
os.environ.pop("OF_SNAPSHOT_KEEP")
check("prune: 2 automatic kept",
      one("SELECT COUNT(*) FROM portal_config_snapshots WHERE reason <>"
          " 'manual'")[0] == 2)
check("prune never removes manual snapshots",
      one("SELECT COUNT(*) FROM portal_config_snapshots WHERE reason ="
          " 'manual'")[0] == 1)

# --- manual cap + delete (owner only) ----------------------------------------
os.environ["OF_SNAPSHOT_MANUAL_MAX"] = "1"
r = client.post(SNAP, headers=J, data=json.dumps({"label": "x"}))
check("manual cap -> 409", r.status_code == 409, r.status_code)
os.environ.pop("OF_SNAPSHOT_MANUAL_MAX")
as_principal(dict(OWNER, role="admin"))
check("admin cannot delete (403)",
      client.delete(SNAP + "/" + str(good["id"])).status_code == 403)
as_principal(OWNER)
check("owner deletes 200",
      client.delete(SNAP + "/" + str(good["id"])).status_code == 200)
check("delete again -> 404",
      client.delete(SNAP + "/" + str(good["id"])).status_code == 404)

# --- other workspaces are invisible -------------------------------------------
as_principal(dict(OWNER, client_id=2))
check("workspace 2 sees no snapshots",
      client.get(SNAP).get_json()["snapshots"] == [])
check("workspace 2 cannot read workspace 1 approvals",
      client.get(URL + "/" + str(link_id)).status_code == 404)
as_principal(OWNER)

for stub in stubs:
    stub.restore()
server.cleanup()
summary("approvals_v2")
