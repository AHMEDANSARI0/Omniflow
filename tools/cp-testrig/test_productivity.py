"""281-295 part 1: saved replies v2 (edit + usage) and activity CSV export."""
import csv
import io
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_conversations, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_conversations.py", encoding="utf8").read()

REPLY_ROW = {"id": 4, "shortcut": "pricing", "body": "Rates are in the catalog.",
             "created_at": None}


def fresh(script):
    portal_conversations._SAVED_USAGE_DDL_READY = True
    conn = install_db_stub(portal_conversations, script)
    portal_conversations.portal_db.SAVED_REPLIES_TABLE = "portal_saved_replies"
    return conn


app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_conversations, principal=human)

print("== module pins ==")

check("usage ddl flag", "_SAVED_USAGE_DDL_READY" in SRC, "flag")
check("alter use_count", "ADD COLUMN IF NOT EXISTS use_count INT NOT NULL DEFAULT 0" in SRC, "alter1")
check("alter last_used", "ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ" in SRC, "alter2")
check("put route", '@bp.put("/saved-replies/<int:reply_id>")' in SRC, "put")
check("use route", '@bp.post("/saved-replies/<int:reply_id>/use")' in SRC, "use")
check("export route", '@bp.get("/activity/export")' in SRC, "export")
check("dup excludes self", "AND id <> %s" in SRC, "dupself")
check("bump sql", "COALESCE(use_count, 0) + 1" in SRC, "bump")
check("audit updated", '"saved_reply.updated"' in SRC, "audit")
check("list coalesce", "COALESCE(use_count, 0) AS use_count, last_used_at" in SRC, "listsel")
check("export scoped", '" WHERE client_id = %s"' in SRC, "scope")
check("export cap 2000", "LIMIT 2000" in SRC, "cap")
check("export csv name", "omniflow-activity.csv" in SRC, "name")
check("list ensures columns", "_ensure_saved_usage_columns(conn)" in SRC, "ensure")

print("== update saved reply ==")

conn = fresh([[], [{"id": 4, "shortcut": "rates", "body": "New rates.",
                    "created_at": None}], []])
response = client.put("/api/v1/portal/saved-replies/4",
                      json={"shortcut": "rates", "body": "New rates."})
check("update 200", response.status_code == 200, response.status_code)
check("update reply echoed", (response.get_json() or {}).get("reply", {})
      .get("shortcut") == "rates", "echo")
check("dup check first", "LOWER(shortcut) = LOWER(%s)" in conn.cur.executed[0][0],
      "dupsql")
update_sql, update_params = conn.cur.executed[1]
check("update scoped", "WHERE id = %s AND client_id = %s" in update_sql, "scope")
check("update params", update_params[0] == "rates" and
      update_params[2] == 4 and update_params[3] == 1, "params")
audit_sql, audit_params = conn.cur.executed[2]
check("audit action", audit_params[1] == "saved_reply.updated", "audit")
check("commit", conn.committed is True, "commit")

conn = fresh([[{"id": 9}]])
response = client.put("/api/v1/portal/saved-replies/4",
                      json={"shortcut": "pricing", "body": "x"})
check("dup 409", response.status_code == 409, response.status_code)

conn = fresh([[], []])
response = client.put("/api/v1/portal/saved-replies/4",
                      json={"shortcut": "pricing", "body": "x"})
check("missing 404", response.status_code == 404, response.status_code)

conn = fresh([])
response = client.put("/api/v1/portal/saved-replies/4",
                      json={"shortcut": "Bad Shortcut!", "body": "x"})
check("bad shortcut 400", response.status_code == 400, response.status_code)

conn = fresh([])
response = client.put("/api/v1/portal/saved-replies/4",
                      json={"shortcut": "ok", "body": "   "})
check("blank body 400", response.status_code == 400, response.status_code)

conn = fresh([])
response = client.put("/api/v1/portal/saved-replies/4",
                      json={"shortcut": "ok", "body": "x" * 1001})
check("long body 400", response.status_code == 400, response.status_code)

print("== use saved reply ==")

conn = fresh([[{"id": 4}]])
response = client.post("/api/v1/portal/saved-replies/4/use")
check("use 200", response.status_code == 200, response.status_code)
use_sql, use_params = conn.cur.executed[0]
check("use sql bumps", "COALESCE(use_count, 0) + 1" in use_sql, "sql")
check("use scoped", "WHERE id = %s AND client_id = %s" in use_sql, "scope")
check("use params", use_params[0] == 4 and use_params[1] == 1, "params")
check("use commits", conn.committed is True, "commit")

conn = fresh([[]])
response = client.post("/api/v1/portal/saved-replies/99/use")
check("use missing 404", response.status_code == 404, response.status_code)

conn = fresh([Exception("db down")])
check("use 503", client.post("/api/v1/portal/saved-replies/4/use").status_code == 503,
      "503")

print("== list shows usage ==")

conn = fresh([[{"id": 4, "shortcut": "pricing", "body": "Rates.",
                "created_at": None, "use_count": 7, "last_used_at": None}]])
response = client.get("/api/v1/portal/saved-replies")
check("list 200", response.status_code == 200, response.status_code)
replies = (response.get_json() or {}).get("replies") or []
check("use count shown", replies and replies[0].get("use_count") == 7, "count")
check("last used shown", replies and "last_used_at" in replies[0], "last")

print("== activity export ==")

conn = fresh([[{"id": 31, "created_at": None, "action": "cod.confirmed",
                "actor_kind": "customer", "note": "Order 12 confirmed",
                "conversation_id": 88}]])
response = client.get("/api/v1/portal/activity/export")
check("export 200", response.status_code == 200, response.status_code)
check("csv content type", "text/csv" in response.content_type, "ctype")
check("csv filename", "omniflow-activity.csv" in
      (response.headers.get("Content-Disposition") or ""), "fname")
rows = list(csv.reader(io.StringIO(response.get_data(as_text=True))))
check("csv header", rows[0] == ["id", "created_at", "action", "actor", "note",
                                "conversation_id"], "header")
check("csv data row", rows[1][0] == "31" and rows[1][2] == "cod.confirmed" and
      rows[1][5] == "88", "row")
export_sql, export_params = conn.cur.executed[0]
check("export table", "portal_action_log" in export_sql, "table")
check("export scoped", "client_id = %s" in export_sql and
      export_params[0] == 1, "scope")
check("export order", "ORDER BY created_at DESC, id DESC" in export_sql, "order")

conn = fresh([[]])
response = client.get("/api/v1/portal/activity/export")
check("empty export ok", response.status_code == 200 and
      response.get_data(as_text=True).startswith("id,created_at"), "empty")

conn = fresh([Exception("boom")])
check("export 503", client.get("/api/v1/portal/activity/export").status_code == 503,
      "503")

print("== auth ==")

PrincipalStub(portal_conversations, principal=None)
check("update 401", client.put("/api/v1/portal/saved-replies/4",
                               json={"shortcut": "a", "body": "b"}).status_code == 401,
      "401")
check("use 401", client.post("/api/v1/portal/saved-replies/4/use").status_code == 401,
      "401")
check("export 401", client.get("/api/v1/portal/activity/export").status_code == 401,
      "401")
PrincipalStub(portal_conversations, principal=human)

summary("productivity")
