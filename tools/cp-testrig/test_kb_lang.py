"""Tests for the multilingual knowledge base (991-1010): lang column DDL,
entry validation + persistence, the language-aware matcher (tier ties,
fallback to the classic SELECT), the auto-reply language lookup, and web
pins (KnowledgeBaseClient language select + filter, portal.ts KbLang)."""
from flask import Flask

import portal_kb
import test_lib
from test_lib import FakeConn, check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_kb.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_kb, principal=human)


def fresh(script):
    portal_kb._LANG_DDL_READY = True
    portal_kb._BRAND_DDL_READY = True
    db = install_db_stub(portal_kb, script)
    portal_kb.portal_db.MSGS_TABLE = "portal_messages"
    portal_kb.portal_db.CMD_TABLE = "portal_connector_commands"
    return db


ENTRY = {"id": 3, "title": "Delivery", "category": "general",
         "keywords": "delivery, kitne din", "content": "2-3 din",
         "is_active": True, "usage_count": 2, "lang": "ur"}

print("== payload validation ==")

# jsonify in the validator needs a request context
_ctx = app.test_request_context()
_ctx.push()
clean, err = portal_kb._clean_entry_payload(
    {"title": "T", "content": "C", "lang": " UR "})
check("lang normalized", err is None and clean["lang"] == "ur", clean)
clean, err = portal_kb._clean_entry_payload({"title": "T", "content": "C"})
check("lang default auto", err is None and clean["lang"] == "auto", clean)
fields, err = portal_kb._clean_entry_payload(
    {"title": "T", "content": "C", "lang": "french"})
check("bad lang 400", err is not None and err[1] == 400
      and fields is None, err)
_ctx.pop()

print("== entry json ==")

check("entry json lang", portal_kb._entry_json(ENTRY)["lang"] == "ur", "-")
check("entry json default", portal_kb._entry_json(
    {"id": 1, "title": "t"})["lang"] == "auto", "-")

print("== lang-aware matcher ==")


def match(rows, text, lang=None):
    conn = FakeConn([rows])
    with conn.cursor() as cur:
        return portal_kb.match_knowledge_base_lang(cur, 1, text, lang)


ur_entry = dict(ENTRY)
auto_entry = {"id": 4, "title": "T", "content": "C",
              "keywords": "delivery", "lang": "auto"}
en_entry = {"id": 5, "title": "T", "content": "C",
            "keywords": "delivery", "lang": "en"}

check("ur wins tie", match([en_entry, auto_entry, ur_entry],
                           "delivery kitne din", "ur")["id"] == 3, "-")
check("auto beats other", match([en_entry, auto_entry], "delivery",
                                "ur")["id"] == 4, "-")
check("score dominates", match(
    [{"id": 6, "keywords": "delivery time, time schedule", "lang": "en"},
     ur_entry], "delivery time schedule", "ur")["id"] == 6, "-")
check("no lang -> auto tier", match([en_entry, auto_entry], "delivery",
                                    None)["id"] == 4, "-")
check("no match", match([en_entry], "refund") is None, "-")
check("empty text", match([ur_entry], "   ", "ur") is None, "-")
check("min score gate", match(
    [{"id": 7, "keywords": "y", "lang": "ur"}], "x", "ur") is None, "-")
check("one hit meets min", match(
    [{"id": 7, "keywords": "x", "lang": "ur"}], "x", "ur")["id"] == 7, "-")

# fallback when the lang column is missing (first SELECT raises)
conn = FakeConn([RuntimeError("column lang does not exist"), [ur_entry]])
with conn.cursor() as cur:
    got = portal_kb.match_knowledge_base_lang(cur, 1, "delivery", "ur")
check("fallback select", got is not None and got["id"] == 3, got)
check("fallback sql", "lang FROM" not in conn.cur.executed[1][0],
      conn.cur.executed[1][0][:80])

print("== auto-reply language lookup ==")

conn = FakeConn([
    [{"auto_reply": True}],                     # settings
    [],                                         # outbound cooldown
    [{"lang": "roman"}],                        # stored language
    [{"id": 3, "title": "T", "content": "Hi {name}", "keywords": "price",
      "lang": "roman"}],                        # entries (lang-aware select)
    [],                                         # command insert RETURNING
    [],                                         # usage bump
])
portal_kb.maybe_auto_reply(1, 7, "923001234567", "Ali", "price?", "general",
                           conn)
executed = conn.cur.executed
check("stored lang queried", any("portal_contact_lang" in sql
                                 for sql, _ in executed), len(executed))
check("lang-aware select", any("lang FROM" in sql and "portal_kb_entries"
                               in sql for sql, _ in executed), "-")
queued = [params for sql, params in executed
          if "INSERT INTO" in sql and "portal_connector_commands" in sql]
check("answer queued", queued and "Hi Ali" in queued[0][1], queued)


print("== endpoints ==")

conn = fresh([[], [], [], []])
response = client.get("/api/v1/portal/kb")
check("list 200", status(response) == 200, status(response))
check("list select has lang", "lang, brand_id FROM"
      in conn.cur.executed[2][0],
      conn.cur.executed[2][0][:80])

conn = fresh([[], [{"auto_reply": True}], [dict(ENTRY)]])
response = client.get("/api/v1/portal/kb")
check("list entry lang", response.get_json()["entries"][0]["lang"] == "ur",
      response.get_json())

conn = fresh([[], [dict(ENTRY, lang="roman")]])
response = client.post("/api/v1/portal/kb",
                       json={"entry": {"title": "T", "content": "C",
                                       "lang": "roman"}})
payload = response.get_json()
check("create 200", status(response) == 200
      and payload["entry"]["lang"] == "roman", payload)
ins_sql, ins_params = conn.cur.executed[1]
check("insert carries lang", "lang, brand_id)" in ins_sql
      and ins_params[6] == "roman" and ins_params[7] is None,
      ins_sql[:80])

conn = fresh([])
response = client.post("/api/v1/portal/kb",
                       json={"entry": {"title": "T", "content": "C",
                                       "lang": "de"}})
check("create bad lang 400", status(response) == 400
      and len(conn.cur.executed) == 0, status(response))

conn = fresh([[dict(ENTRY, lang="en")]])
response = client.put("/api/v1/portal/kb/3",
                      json={"entry": {"title": "T", "content": "C",
                                      "lang": "en"}})
check("update 200", status(response) == 200
      and response.get_json()["entry"]["lang"] == "en", status(response))
upd_sql, upd_params = conn.cur.executed[0]
check("update set lang", "lang = %s" in upd_sql and upd_params[4] == "en",
      upd_sql[:80])

conn = fresh([])
response = client.put("/api/v1/portal/kb/3",
                      json={"entry": {"title": "T", "content": "C",
                                      "lang": "es"}})
check("update bad lang 400", status(response) == 400, status(response))

print("== lazy DDL ==")

portal_kb._LANG_DDL_READY = False
conn = FakeConn([[], [], [], []])
with conn.cursor() as cur:
    portal_kb._ensure_lang_column(conn)
check("alter executed", "ADD COLUMN IF NOT EXISTS lang" in
      conn.cur.executed[0][0], conn.cur.executed[0][0][:80])
portal_kb._ensure_lang_column(conn)
check("ddl once", len(conn.cur.executed) == 1, len(conn.cur.executed))
portal_kb._LANG_DDL_READY = True

conn = FakeConn([RuntimeError("no perms")])
with conn.cursor() as cur:
    portal_kb._ensure_lang_column(conn)
check("ddl failure safe", True, "-")

print("== web shape ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
check("KbLang type", 'export type KbLang = "auto" | "en" | "ur" | "roman";'
      in PORTAL, "type")
check("entry lang mapped", "lang:" in PORTAL
      and 'raw.lang === "roman"' in PORTAL, "mapper")
check("clients send lang", PORTAL.count("lang: entry.lang") == 2, "-")

CLIENT = open("/tmp/p13/Omniflow/app/dashboard/(portal)/knowledge-base/"
              "KnowledgeBaseClient.tsx", encoding="utf8").read()
check("form language select", 'id="kbLang"' in CLIENT
      and "LANG_LABELS" in CLIENT, "select")
check("filter", 'langFilter' in CLIENT and 'setLangFilter' in CLIENT, "filter")
check("row chip", "LANG_LABELS[entry.lang" in CLIENT, "chip")

summary("kb_lang")
