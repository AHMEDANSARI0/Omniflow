"""Tests for B7: portal_memory (customer memory CRUD + purge, journey
stages + transitions-as-events + note_purchase automation, explain from
audit) + wiring pins (checkout auto-advance, app.py bp, Customer 360
cards, BFF routes, portal.ts clients)."""
from flask import Flask

import portal_memory
import portal_db
from test_lib import install_db_stub
from test_lib import check, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}


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
    portal_memory._DDL_READY = True
    db = install_db_stub(portal_memory, script)
    portal_memory.portal_db.CONV_TABLE = "portal_conversations"
    return db


def run_api(script, method, path, json_body=None, query="",
            principal=PRINCIPAL):
    fresh(script)
    app = Flask("memory-test")
    app.register_blueprint(portal_memory.bp)
    with PrincipalStub(portal_memory, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path + query)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "PUT":
            return client.put(path, json=json_body)
        if method == "DELETE":
            return client.delete(path + query)
    return None


# ---------- memory core ----------

check("add rejects empty contact",
      portal_memory.add_memory(type("C", (), {"execute": lambda *a: None})(),
                               1, "", "note", "x") is None, "empty")

conn = fresh([[{"id": 5}], []])
with conn.cur as cur:
    mid = portal_memory.add_memory(cur, 1, "92300", "note", "evening delivery")
check("add returns id", mid == 5, mid)

conn = fresh([
    [{"id": 3, "kind": "note", "content": "b", "created_by": "owner",
      "created_at": "t", "updated_at": "t"},
     {"id": 2, "kind": "fact", "content": "a", "created_by": "ai",
      "created_at": "t", "updated_at": "t"}]])
with conn.cur as cur:
    rows = portal_memory.list_memory(cur, 1, "92300")
check("list newest first", [r["id"] for r in rows] == [3, 2], rows)
check("list tenant scoped", "client_id" in conn.cur.executed[0][1][0:1] or
      1 in conn.cur.executed[0][1], conn.cur.executed[0])

portal_memory.MEMORY_CAP = 3
conn = fresh([[{"id": 1}], [], [{"id": 2}], [], [{"id": 3}], [],
              [{"id": 4}], [], [{"id": 5}], []])
with conn.cur as cur:
    for k in range(5):
        portal_memory.add_memory(cur, 1, "92300", "note", "entry %d" % k)
trims = [s for s, p in conn.cur.executed
         if s.startswith("DELETE FROM portal_customer_memory")
         and "NOT IN" in s]
check("cap trims oldest", len(trims) >= 1, len(trims))
portal_memory.MEMORY_CAP = 50

conn = fresh([[{"id": 9}], []])
with conn.cur as cur:
    check("update ok",
          portal_memory.update_memory(cur, 1, 9, "new text", "fact") is True,
          "ok")
check("update sql has returning", any("RETURNING id" in s and "UPDATE" in s
                                      for s, p in conn.cur.executed),
      "sql")
conn = fresh([[]])
with conn.cur as cur:
    check("update cross-tenant False",
          portal_memory.update_memory(cur, 2, 9, "x") is False, "false")

conn = fresh([[{"id": 9}]])
with conn.cur as cur:
    check("delete ok",
          portal_memory.delete_memory(cur, 1, 9) is True, "ok")
conn = fresh([[]])
with conn.cur as cur:
    check("delete cross-tenant False",
          portal_memory.delete_memory(cur, 2, 9) is False, "false")

conn = fresh([[{"id": 1}, {"id": 2}], []])
with conn.cur as cur:
    check("purge counts", portal_memory.purge_memory(cur, 1, "92300") == 2,
          "2")
check("purge clears journey state too",
      any("portal_journey_state" in s for s, p in conn.cur.executed), "state")

conn = fresh([[], [{"id": 4}], []])
with conn.cur as cur:
    check("remember_fact adds",
          portal_memory.remember_fact(cur, 1, "92300", "likes COD") == 4, "4")
conn = fresh([[{"1": 1}]])
with conn.cur as cur:
    check("remember_fact dedupes",
          portal_memory.remember_fact(cur, 1, "92300", "likes COD") is None,
          "dupe")

# ---------- upgrade: mtype / source / confidence / expiry ----------

check("upgrade ddl cols",
      all(c in portal_memory._DDL for c in
          ("mtype", "source", "confidence", "expires_at"))
      and "ADD COLUMN IF NOT EXISTS mtype" in portal_memory._DDL,
      "ddl")
check("mtypes vocab", portal_memory.MTYPES ==
      ("short", "long", "business", "journey"), portal_memory.MTYPES)
check("sources vocab", portal_memory.SOURCES ==
      ("owner", "ai", "automation"), portal_memory.SOURCES)

conn = fresh([[{"id": 5}], []])
with conn.cur as cur:
    mid = portal_memory.add_memory(cur, 1, "92300", "note",
                                   "Prefers evening", mtype="short",
                                   source="ai", confidence=0.8)
check("add with metadata", mid == 5, mid)
ins = [(s, p) for s, p in conn.cur.executed
       if "INSERT INTO portal_customer_memory" in s]
check("add metadata in insert", ins and "mtype" in ins[0][0]
      and ins[0][1][5] == "short" and ins[0][1][6] == "ai"
      and abs(ins[0][1][7] - 0.8) < 0.01, ins[0][1] if ins else "none")
with conn.cur as cur:
    check("add bad mtype -> None",
          portal_memory.add_memory(cur, 1, "92300", "note", "x",
                                   mtype="godmode") is None, "none")
row = {"id": 3, "kind": "note", "content": "x", "created_by": "owner",
       "mtype": "business", "source": "automation", "confidence": 0.5,
       "expires_at": "e", "created_at": "c", "updated_at": "u"}
pub = portal_memory._memory_public(row)
check("public shaped", pub["mtype"] == "business"
      and pub["source"] == "automation"
      and abs(pub["confidence"] - 0.5) < 0.01
      and pub["expires_at"] == "e", pub)

conn = fresh([[row]])
with conn.cur as cur:
    rows = portal_memory.list_memory(cur, 1, "92300")
check("list expiry filter", any(
      "expires_at IS NULL OR expires_at > NOW()" in s
      for s, p in conn.cur.executed), "where")
check("list shaped rows", rows[0]["mtype"] == "business", rows)

conn = fresh([[{"id": 9}]])
with conn.cur as cur:
    check("update mtype + expiry", portal_memory.update_memory(
        cur, 1, 9, "new text", mtype="business", expires_hours=24) is True,
        "ok")
upd = [(s, p) for s, p in conn.cur.executed if "UPDATE" in s]
check("update sets mtype + interval", upd and "mtype = %s" in upd[0][0]
      and "make_interval(hours => %s)" in upd[0][0]
      and upd[0][1][1] == "business", upd[0][1] if upd else "none")
conn = fresh([[{"id": 9}]])
with conn.cur as cur:
    check("clear expiry", portal_memory.update_memory(
        cur, 1, 9, "new text", expires_hours=0) is True, "ok")
check("clear expiry sql", any("expires_at = NULL" in s
                              for s, p in conn.cur.executed), "null")
with conn.cur as cur:
    check("update bad mtype -> False", portal_memory.update_memory(
        cur, 1, 9, "x", mtype="godmode") is False, "false")

r = run_api([], "POST", "/api/v1/portal/memory",
            {"contact": "92300", "kind": "note", "content": "x",
             "mtype": "godmode"})
check("post 400 bad mtype", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/memory",
            {"contact": "92300", "kind": "note", "content": "x",
             "expires_hours": -5})
check("post 400 bad expiry", r.status_code == 400, r.status_code)
r = run_api([[{"id": 7}], [], []], "POST", "/api/v1/portal/memory",
            {"contact": "92300", "kind": "note", "content": "x",
             "mtype": "short", "expires_hours": 24})
check("post 200 with mtype + expiry", r.status_code == 200
      and r.get_json()["memory"]["mtype"] == "short"
      and r.get_json()["memory"]["expires_at"], r.get_json())
r = run_api([], "PUT", "/api/v1/portal/memory/9",
            {"content": "x", "mtype": "godmode"})
check("put 400 bad mtype", r.status_code == 400, r.status_code)
r = run_api([[{"id": 9}]], "PUT", "/api/v1/portal/memory/9",
            {"content": "new", "mtype": "long", "expires_hours": 0})
check("put 200 mtype + clear expiry", r.status_code == 200, r.status_code)

# ---------- journey ----------

conn = fresh([
    [],                                    # _ensure_stages: none yet
    [], [], [],                            # 3 default INSERTs
    [{"id": 1, "name": "New", "position": 1, "is_active": True},
     {"id": 2, "name": "Engaged", "position": 2, "is_active": True},
     {"id": 3, "name": "Customer", "position": 3, "is_active": True}],
])
with conn.cur as cur:
    stages = portal_memory.list_stages(cur, 1)
check("default stages seeded", [s["name"] for s in stages] ==
      ["New", "Engaged", "Customer"], stages)

conn = fresh([
    [{"n": 12}],                           # stage count at cap
])
with conn.cur as cur:
    check("add_stage respects cap",
          portal_memory.add_stage(cur, 1, "VIP") is None, "cap")
conn = fresh([
    [{"n": 1}],
    [{"next": 2}],
    [],                                    # ON CONFLICT DO NOTHING -> gone
])
with conn.cur as cur:
    check("add_stage dup -> None",
          portal_memory.add_stage(cur, 1, "New") is None, "dup")
conn = fresh([
    [{"n": 1}],
    [{"next": 2}],
    [{"id": 7}],
])
with conn.cur as cur:
    stage = portal_memory.add_stage(cur, 1, "Wholesale")
check("add_stage ok", stage == {"id": 7, "name": "Wholesale",
                                "position": 2, "is_active": True}, stage)

conn = fresh([[{"1": 1}]])
with conn.cur as cur:
    check("delete_stage in-use -> None",
          portal_memory.delete_stage(cur, 1, 3) is None, "in-use")
conn = fresh([[], [{"id": 7}]])
with conn.cur as cur:
    check("delete_stage ok",
          portal_memory.delete_stage(cur, 1, 7) is True, "ok")
conn = fresh([[], []])
with conn.cur as cur:
    check("delete_stage missing -> False",
          portal_memory.delete_stage(cur, 1, 99) is False, "missing")

conn = fresh([
    [{"id": 3, "name": "Customer"}],       # stage lookup
    [],                                    # previous state (none)
    [],                                    # state upsert
    [{"id": 11}],                          # event insert
    [{"id": 21}],                          # journey memory insert
    [],                                    # memory trim
    [],                                    # log_action
])
with conn.cur as cur:
    moved = portal_memory.move_contact(cur, 1, "92300", 3)
check("move ok", moved == {"id": 3, "name": "Customer"}, moved)
sqls = [s for s, p in conn.cur.executed]
check("move writes event", any("portal_journey_events" in s for s in sqls),
      "event")
mem_ins = [(s, p) for s, p in conn.cur.executed
           if "INSERT INTO portal_customer_memory" in s]
check("move writes journey-type memory", len(mem_ins) == 1
      and "Journey stage: Customer" in str(mem_ins[0][1])
      and mem_ins[0][1][5] == "journey", mem_ins)
check("move writes audit", any("journey.stage" in str(p) or
                               "journey.stage" in s for s, p in
                               conn.cur.executed), "audit")

conn = fresh([
    [{"id": 3, "name": "Customer"}],
    [{"stage_id": 3}],                     # already there
])
with conn.cur as cur:
    check("move same stage idempotent",
          portal_memory.move_contact(cur, 1, "92300", 3) ==
          {"id": 3, "name": "Customer"}, "same")
check("no duplicate event on same stage",
      not any("portal_journey_events" in s for s, p in conn.cur.executed),
      "no-event")

conn = fresh([[]])
with conn.cur as cur:
    check("move bad stage -> None",
          portal_memory.move_contact(cur, 1, "92300", 99) is None, "none")

conn = fresh([
    [],                                    # stage Customer missing
])
with conn.cur as cur:
    check("note_purchase no stage -> None",
          portal_memory.note_purchase(cur, 1, "92300") is None, "none")
conn = fresh([
    [{"id": 3}],
    [{"stage_id": 3}],                     # already Customer
])
with conn.cur as cur:
    check("note_purchase already -> False",
          portal_memory.note_purchase(cur, 1, "92300") is False, "false")
conn = fresh([
    [{"id": 3}],
    [],
    [{"id": 3, "name": "Customer"}],
    [],
    [],
    [{"id": 12}],
    [{"id": 22}],                          # journey memory insert
    [],                                    # memory trim
    [],                                    # log_action
])
with conn.cur as cur:
    check("note_purchase advances",
          portal_memory.note_purchase(cur, 1, "92300") is True, "advanced")
check("auto event source automation",
      any("automation" in str(p) for s, p in conn.cur.executed
          if "portal_journey_events" in s), "auto")

conn = fresh([
    [{"1": 1}],                            # _ensure_stages: already seeded
    [{"id": 2, "name": "Engaged", "position": 2, "is_active": True}],
    [{"id": 2, "name": "Engaged", "updated_at": "t"}],
    [{"stage_name": "Engaged", "source": "owner", "created_at": "t"}],
])
with conn.cur as cur:
    snap = portal_memory.journey_snapshot(cur, 1, "92300")
check("snapshot shape", snap["stages"][0]["name"] == "Engaged"
      and snap["current"]["name"] == "Engaged"
      and snap["events"][0]["source"] == "owner", snap)

# ---------- explain ----------

conn = fresh([[{"action": "ai.answer", "actor_kind": "automation",
                "note": "Brain answered", "created_at": "t"}]])
with conn.cur as cur:
    rows = portal_memory.explain_contact(cur, 1, "92300")
check("explain rows", rows[0]["action"] == "ai.answer", rows)
conn = fresh([[]])
with conn.cur as cur:
    check("explain empty contact -> []",
          portal_memory.explain_contact(cur, 1, "") == [], "[]")

# ---------- owner API matrix ----------

r = run_api([[]], "GET", "/api/v1/portal/memory",
            query="?contact=92300")
check("memory get 200", r.status_code == 200 and r.get_json()["cap"] == 50,
      r.get_json())
r = run_api([], "GET", "/api/v1/portal/memory")
check("memory get 400 no contact", r.status_code == 400, r.status_code)

r = run_api([[{"id": 7}], [], []], "POST", "/api/v1/portal/memory",
            {"contact": "92300", "kind": "note", "content": "x"})
check("memory post 200", r.status_code == 200, r.status_code)
r = run_api([], "POST", "/api/v1/portal/memory",
            {"contact": "92300", "kind": "secret", "content": "x"})
check("memory post 400 kind", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/memory", {"contact": "92300"})
check("memory post 400 content", r.status_code == 400, r.status_code)

r = run_api([[]], "PUT", "/api/v1/portal/memory/9", {"content": "x"})
check("memory put cross-tenant 404", r.status_code == 404, r.status_code)
r = run_api([[{"id": 9}]], "PUT", "/api/v1/portal/memory/9",
            {"content": "new"})
check("memory put 200", r.status_code == 200, r.status_code)
r = run_api([[]], "DELETE", "/api/v1/portal/memory/9")
check("memory delete 404", r.status_code == 404, r.status_code)
r = run_api([[{"id": 9}]], "DELETE", "/api/v1/portal/memory/9")
check("memory delete 200", r.status_code == 200, r.status_code)

# §214: purge also deletes the contact's stored files (SAVEPOINT, media
# table DDL once, DELETE ... RETURNING, RELEASE) before the audit row.
import portal_inbound_media as _inbound_media
_inbound_media._DDL_READY = False
r = run_api([[{"id": 1}, {"id": 2}], [], [], [], [], [], []], "DELETE",
            "/api/v1/portal/memory", query="?contact=92300")
check("memory purge 200", r.status_code == 200
      and r.get_json()["purged"] == 2, r.get_json())
_purge_sql = [str(e[0]) for e in portal_memory.portal_db.conn.cur.executed]
check("memory purge also forgets the contact's files",
      any("DELETE FROM portal_inbound_media" in q for q in _purge_sql)
      and any(e[1] == (1, "92300") for e in portal_memory.portal_db.conn.cur
              .executed if "portal_inbound_media WHERE" in str(e[0])),
      _purge_sql)
r = run_api([], "DELETE", "/api/v1/portal/memory")
check("memory purge 400 no contact", r.status_code == 400, r.status_code)

r = run_api([
    [{"1": 1}],
    [{"id": 1, "name": "New", "position": 1, "is_active": True}],
    [{"id": 1, "name": "New", "updated_at": "t"}],
    [{"stage_name": "New", "source": "owner", "created_at": "t"}],
], "GET", "/api/v1/portal/journey", query="?contact=92300")
check("journey get 200", r.status_code == 200
      and r.get_json()["stages"][0]["name"] == "New", r.get_json())

r = run_api([], "PUT", "/api/v1/portal/journey", {"contact": "92300"})
check("journey put 400 no stage", r.status_code == 400, r.status_code)
r = run_api([[]], "PUT", "/api/v1/portal/journey",
            {"contact": "92300", "stage_id": 99})
check("journey move 404 bad stage", r.status_code == 404, r.status_code)
r = run_api([
    [{"id": 3, "name": "Customer"}], [], [], [{"id": 11}], [],
    [{"id": 23}], [], [],
], "PUT", "/api/v1/portal/journey", {"contact": "92300", "stage_id": 3})
check("journey move 200", r.status_code == 200
      and r.get_json()["current"]["name"] == "Customer", r.get_json())

r = run_api([
    [{"n": 1}], [{"next": 2}], [{"id": 7}],
], "POST", "/api/v1/portal/journey/stages", {"name": "Wholesale"})
check("stage post 200", r.status_code == 200
      and r.get_json()["stage"]["name"] == "Wholesale", r.get_json())
r = run_api([], "POST", "/api/v1/portal/journey/stages", {"name": ""})
check("stage post 400 empty", r.status_code == 400, r.status_code)

r = run_api([[{"1": 1}]], "DELETE", "/api/v1/portal/journey/stages/3")
check("stage delete 409 in-use", r.status_code == 409, r.status_code)
r = run_api([[], []], "DELETE", "/api/v1/portal/journey/stages/99")
check("stage delete 404", r.status_code == 404, r.status_code)
r = run_api([[], [{"id": 7}]], "DELETE", "/api/v1/portal/journey/stages/7")
check("stage delete 200", r.status_code == 200, r.status_code)

r = run_api([], "GET", "/api/v1/portal/explain")
check("explain 400 no contact", r.status_code == 400, r.status_code)
r = run_api([[{"action": "cod.confirmed", "actor_kind": "automation",
               "note": "n", "created_at": "t"}]], "GET",
            "/api/v1/portal/explain", query="?contact=92300")
check("explain 200", r.status_code == 200
      and r.get_json()["activity"][0]["action"] == "cod.confirmed",
      r.get_json())

API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)
r = run_api([[]], "GET", "/api/v1/portal/memory", query="?contact=x",
            principal=API_KEY_PRINCIPAL)
check("api key 403 memory", r.status_code == 403, r.status_code)
r = run_api([[]], "DELETE", "/api/v1/portal/memory", query="?contact=x",
            principal=API_KEY_PRINCIPAL)
check("api key 403 purge", r.status_code == 403, r.status_code)
r = run_api([[]], "GET", "/api/v1/portal/journey", query="?contact=x",
            principal=None)
check("anon 401 journey", r.status_code == 401, r.status_code)

# ---------- wiring pins ----------

CHECKOUT = open("/tmp/smoke971/portal_checkout.py", encoding="utf8").read()
check("checkout auto-advance wired",
      "portal_memory.note_purchase(" in CHECKOUT, "wire")
check("checkout passes contact_id",
      "RETURNING paid_amount, total, status, contact_id" in CHECKOUT,
      "returning")
check("auto-advance fail-silent",
      CHECKOUT.index("import portal_memory")
      < CHECKOUT.index("except Exception:", CHECKOUT.index("import portal_memory")),
      "guard")
APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers memory bp",
      "aux_app.register_blueprint(portal_memory_bp)" in APP, "bp")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("listCustomerMemory", "addCustomerMemory", "updateCustomerMemory",
           "deleteCustomerMemory", "purgeCustomerMemory", "getJourney",
           "moveJourneyStage", "addJourneyStage", "deleteJourneyStage",
           "getExplain"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
PROFILE = open(
    "/tmp/smoke971/profile_client.tsx", encoding="utf8").read()
check("profile mounts memory card",
      "<CustomerMemoryCard contact={contact} />" in PROFILE, "mount")
check("profile mounts journey card",
      "<CustomerJourneyCard contact={contact} />" in PROFILE, "mount")
CARD = open("/tmp/smoke971/memory_card.tsx", encoding="utf8").read()
check("memory card has purge", "Forget all" in CARD
      and "portal/memory?contact=" in CARD, "purge")
JCARD = open("/tmp/smoke971/journey_card.tsx", encoding="utf8").read()
check("journey card has explain", "Why this happened" in JCARD
      and "portal/explain?contact=" in JCARD, "explain")
for route in ("memory", "journey", "journey/stages", "explain"):
    src = open("/tmp/smoke971/bff_" + route.replace("/", "_") + ".ts",
               encoding="utf8").read()
    check("bff " + route, "export async function" in src, route)
for extra in ("memory_id", "stage_id"):
    src = open("/tmp/smoke971/bff_id_" + extra + ".ts",
               encoding="utf8").read()
    check("bff id route " + extra, "export async function" in src, extra)

summary("memory")
