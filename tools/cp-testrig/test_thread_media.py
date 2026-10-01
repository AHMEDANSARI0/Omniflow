"""§215: customer images / voice notes inside their chat bubbles.

Covers:
  * media store DDL migrates in place (message_id column + index);
  * capture records the message id (and ignores junk ids);
  * the list API returns message_id, matching files captured before
    §215 to the single inbound message written in the same transaction
    (ambiguous batches stay unattached), tenant-scoped;
  * the connector asks for the message id ONLY for inbound media
    (functional run of ingest_messages_for_tenant) and passes it on;
    every other message keeps the plain INSERT;
  * website: shared helpers, MessageMedia bubble previews, ThreadClient
    wiring (reload on newer customer message + on delete), MediaCard keeps
    a compact row for files already shown in the chat.
"""
import json
import os

from flask import Flask

import test_lib
from test_lib import (FakeCur, PrincipalStub, check, human_principal,
                      install_db_stub, summary)

import portal_inbound_media as im

RIG = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def src(rel):
    with open(os.path.join(RIG, rel), encoding="utf8") as handle:
        return handle.read()


JPEG = b"\xff\xd8\xff\xe0" + b"j" * 64

print("== DDL migrates in place ==")
check("message_id column added if missing",
      "ALTER TABLE portal_inbound_media ADD COLUMN IF NOT EXISTS message_id"
      " BIGINT" in im._DDL, "alter")
check("message index", "portal_inbound_media_msg_idx" in im._DDL
      and "(client_id, message_id) WHERE message_id IS NOT NULL" in im._DDL,
      "index")
im._DDL_READY = False
cur = FakeCur([[]])
im.ensure_ddl(cur)
check("one DDL round trip (existing tables untouched)", len(cur.executed) == 1
      and "CREATE TABLE IF NOT EXISTS" in cur.executed[0][0], cur.executed)
im._DDL_READY = True
im._CS_READY = True

print("== capture records the message id ==")


def run_capture(message_id):
    cur = FakeCur([[], [{"media_store": None}], [], [], [{"used": 0}], []])
    item = {"channel": "telegram", "from": "tg:9", "id": "tg-1",
            "direction": "in", "media": [{"type": "image"}]}
    if message_id == "omit":
        im.capture(cur, 7, 55, item, [JPEG])
    else:
        im.capture(cur, 7, 55, item, [JPEG], None, message_id)
    ins = [e for e in cur.executed
           if str(e[0]).startswith("INSERT INTO portal_inbound_media")]
    return ins[0] if ins else ("", ())


sql, params = run_capture(901)
check("insert names message_id last", sql.count("%s") == len(params)
      and "stored_at, message_id)" in sql and params[-1] == 901, params)
check("existing columns keep their positions", params[:3] == (7, 55,
                                                             "telegram")
      and params[11] == "stored" and params[13] is True, params)
check("no id -> NULL", run_capture("omit")[1][-1] is None, "omit")
check("junk id -> NULL", run_capture("abc")[1][-1] is None, "junk")
check("zero id -> NULL", run_capture(0)[1][-1] is None, "zero")
check("numeric string accepted", run_capture("42")[1][-1] == 42, "str")

print("== list API ==")
app = Flask("thread-media")
app.register_blueprint(im.bp)
client = app.test_client()
PrincipalStub(im, principal=human_principal(client_id=7))
row = {"id": 3, "kind": "image", "mime": "image/jpeg", "size_bytes": 68,
       "status": "stored", "note": "", "channel": "telegram",
       "external_id": "tg-1", "has_copy": True, "has_link": False,
       "created_at": "2026-10-01", "message_id": 901}
conn = install_db_stub(im, [[{"id": 55}], [row, dict(row, id=4,
                                                     message_id=None)]],
                       client_id=7)
r = client.get("/api/v1/portal/conversations/55/media")
media = (r.get_json() or {}).get("media") or []
check("message_id returned", [m.get("message_id") for m in media] ==
      [901, None], media)
list_sql, list_params = conn.cur.executed[1]
check("recorded id wins, else same-transaction match",
      "COALESCE(f.message_id, (SELECT MIN(m.id) FROM" in list_sql
      and "m.created_at = f.created_at" in list_sql
      and "m.direction = 'in'" in list_sql, list_sql)
check("ambiguous batches stay unattached", "HAVING COUNT(*) = 1" in list_sql,
      list_sql)
check("fallback stays inside the tenant + conversation",
      "m.client_id = f.client_id" in list_sql
      and "m.conversation_id = f.conversation_id" in list_sql
      and list_params == (7, 55, im.LIST_LIMIT), list_params)
check("list limit is env-backed", im.LIST_LIMIT == 100
      and 'OF_MEDIA_STORE_LIST_LIMIT' in src(
          "omniflow-backend-patch/portal_inbound_media.py"), im.LIST_LIMIT)
check("public row coerces ids", im._row_public(dict(row, message_id="12"))
      ["message_id"] == 12 and im._row_public(dict(row, message_id=0))
      ["message_id"] is None, "coerce")

print("== connector: message id only for inbound media ==")
import connector_api
import portal_events
import portal_media_ai


class LooseCur:
    """Records every statement; answers the conversation upsert and the
    message INSERT ... RETURNING id, nothing else."""

    def __init__(self):
        self.executed = []
        self._rows = []
        self.description = None

    def execute(self, sql, params=None):
        sql = str(sql)
        self.executed.append((sql, params))
        if "RETURNING id" in sql and "portal_conversations" in sql:
            self._set([{"id": 55}])
        elif "INSERT INTO portal_messages" in sql and "RETURNING id" in sql:
            self._set([{"id": 901}])
        else:
            self._set([])

    def _set(self, rows):
        self._rows = rows
        self.description = [("id",)] if rows else None

    def fetchall(self):
        return [tuple(r.values()) for r in self._rows]

    def fetchone(self):
        return tuple(self._rows[0].values()) if self._rows else None

    @property
    def rowcount(self):
        return len(self._rows)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class LooseConn:
    def __init__(self):
        self.cur = LooseCur()

    def cursor(self):
        return self.cur

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class LooseDb(test_lib._DbStub):
    def __init__(self):
        super().__init__(client_id=7)
        self.conn = LooseConn()


captured = []
_orig = (connector_api.portal_db, im.capture, portal_events.record_inbound,
         portal_media_ai.enrich)
portal_events.record_inbound = lambda cur, client_id, item: True
portal_media_ai.enrich = lambda *a, **k: None
im.capture = lambda cur, client_id, conv, item, blobs=None, budget=None, \
    message_id=None: captured.append((conv, item.get("id"), message_id)) or 0


RESULTS = []


def ingest(items):
    captured.clear()
    db = LooseDb()
    connector_api.portal_db = db
    try:
        RESULTS.append(connector_api.ingest_messages_for_tenant(
            {"client_id": 7}, items))
    except Exception as error:  # noqa: BLE001
        RESULTS.append(repr(error))
    return [e[0] for e in db.conn.cur.executed
            if "INSERT INTO portal_messages" in e[0]]


def msg(**extra):
    base = {"channel": "telegram", "from": "tg:9", "name": "Ali",
            "body": "hello", "direction": "in", "id": "tg-5"}
    base.update(extra)
    return base


try:
    inserts = ingest([msg(media=[{"type": "image", "url":
                                  "https://cdn.example.com/a.jpg"}])])
    check("inbound media: INSERT ... RETURNING id",
          len(inserts) == 1 and inserts[0].endswith(" RETURNING id"), inserts)
    check("message id handed to capture", captured == [(55, "tg-5", 901)],
          captured)
    check("ingest completes and counts the message", RESULTS[-1] == 1,
          RESULTS[-1])
    inserts = ingest([msg()])
    check("plain inbound message: INSERT unchanged",
          len(inserts) == 1 and "RETURNING" not in inserts[0]
          and captured == [], (inserts, captured))
    inserts = ingest([msg(direction="out", media=[{"type": "image"}])])
    check("outbound media: INSERT unchanged, no capture",
          len(inserts) == 1 and "RETURNING" not in inserts[0]
          and captured == [], (inserts, captured))
    check("every ingest run completes", RESULTS == [1, 1, 1], RESULTS)
finally:
    (connector_api.portal_db, im.capture, portal_events.record_inbound,
     portal_media_ai.enrich) = _orig

connector = src("omniflow-backend-patch/connector_api.py")
check("capture call passes message_id", "store_budget, message_id)" in
      connector, "args")

print("== website ==")
D = "app/dashboard/(portal)/conversations/[id]/"
shared = src(D + "inbound-media-shared.ts")
check("shared type carries message_id", "message_id: number | null;" in
      shared, "type")
check("shared helpers", all(name in shared for name in (
    "export function groupByMessage(", "export async function"
    " fetchConversationMedia(", "export async function fetchMediaLink(",
    "export const MEDIA_CHANGED_EVENT")), "helpers")
check("groupByMessage skips unattached files", "if (!item.message_id)"
      " continue;" in shared, "skip")
bubble = src(D + "MessageMedia.tsx")
check("bubble: image thumbnail opens full image", 'loading="lazy"' in bubble
      and 'rel="noopener noreferrer"' in bubble and "max-h-64" in bubble,
      "img")
check("bubble: voice note player", "<audio" in bubble
      and 'preload="none"' in bubble, "audio")
check("bubble: video / file link on demand", "fetchMediaLink(item.id)" in
      bubble and "Get link" in bubble, "link")
check("bubble: gone files show a note", "no longer available" in bubble
      and "onError={() => markBroken(item.id)}" in bubble, "gone")
check("bubble: no raw html", "dangerouslySetInnerHTML" not in bubble, "html")
thread = src(D + "ThreadClient.tsx")
check("thread: bubble component lazy", 'const MessageMedia = dynamic(() =>'
      ' import("./MessageMedia"));' in thread, "dynamic")
check("thread: reload on newer customer message",
      "}, [id, latestInboundId]);" in thread
      and 'message.direction === "in" && message.id > latest' in thread,
      "reload")
check("thread: reload after delete", "window.addEventListener("
      "MEDIA_CHANGED_EVENT, onChanged)" in thread and
      "window.removeEventListener(MEDIA_CHANGED_EVENT, onChanged)" in thread,
      "event")
check("thread: previews only on customer bubbles",
      'message.direction === "in" && mediaByMessage[message.id] ?' in thread
      and "<MessageMedia items={mediaByMessage[message.id]} />" in thread,
      "render")
check("thread: preview above the text", thread.find("<MessageMedia items=")
      < thread.find("{renderMessageBody(message.body, threadQuery)}"),
      "order")
card = src(D + "MediaCard.tsx")
check("card uses shared helpers", 'from "./inbound-media-shared";' in card
      and "function sizeLabel" not in card, "shared")
check("card: no duplicate preview for files in the chat",
      "!broken[item.id] && !inBubble" in card
      and "Shown in the conversation." in card, "dup")
check("card: delete refreshes the bubbles",
      "window.dispatchEvent(new CustomEvent(MEDIA_CHANGED_EVENT));" in card,
      "dispatch")
lib = src("lib/omniflow/portal.ts")
check("portal.ts type carries message_id", "message_id: number | null;" in
      lib, "lib")
for rel in ("MessageMedia.tsx", "inbound-media-shared.ts", "MediaCard.tsx"):
    text = src(D + rel)
    bad = [ch for ch in "\u25b6\u261d\u2714\u26a1\u2699\u2709\u260e\u2733"
           "\u263a\u25fc\u27a1" if ch in text]
    check("no emoji-capable glyphs " + rel, not bad, bad)

summary("thread_media")
