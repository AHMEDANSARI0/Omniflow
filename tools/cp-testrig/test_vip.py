"""Tests for VIP customer flags (deterministic, read-only)."""
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, install_db_stub, summary

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()


def fresh(script):
    conn = install_db_stub(portal_conversations, script)
    portal_conversations.portal_db.CONV_TABLE = "portal_conversations"
    portal_conversations.portal_db.MSGS_TABLE = "portal_messages"
    return conn


print("== helper ==")

check("threshold is 3", portal_conversations.VIP_THRESHOLD == 3, "3")

conn = fresh([
    [{"oid": "portal_checkout_links"}],
    [{"contact_id": "92a", "orders": 4},
     {"contact_id": "92b", "orders": 1}],
])
with conn.cursor() as cur:
    counts = portal_conversations._paid_order_counts(
        cur, 1, ["92a", "92b", "92a"])
check("counts by contact", counts == {"92a": 4, "92b": 1}, counts)
check("ids deduped via ANY", "ANY" in conn.cur.executed[1][0]
      and conn.cur.executed[1][1][1] == ["92a", "92b"],
      conn.cur.executed[1][1])

conn = fresh([[{"oid": "portal_checkout_links"}],
              [{"contact_id": "92a", "orders": 4}]])
with conn.cursor() as cur:
    counts = portal_conversations._paid_order_counts(cur, 1, ["92a"])
check("single id", counts == {"92a": 4}, counts)

conn = fresh([[]])
with conn.cursor() as cur:
    counts = portal_conversations._paid_order_counts(cur, 1, ["92a"])
check("missing links -> empty", counts == {}, counts)

conn = fresh([])
with conn.cursor() as cur:
    counts = portal_conversations._paid_order_counts(cur, 1, ["92a"])
check("stub exhausted treated as failure", counts == {}, counts)

conn = fresh([
    [{"oid": "portal_checkout_links"}],
    [{"contact_id": "92z", "orders": 9}],
])
with conn.cursor() as cur:
    counts = portal_conversations._paid_order_counts(cur, 1, ["92z"])
check("fresh conn still queries", counts == {"92z": 9}, counts)

conn = fresh([])
with conn.cursor() as cur:
    counts = portal_conversations._paid_order_counts(cur, 1, [None, "", "  "])
check("blank ids skipped without queries", counts == {}
      and len(conn.cur.executed) == 0, conn.cur.executed)

vip = [c for c in [("92a", 4), ("92b", 3), ("92c", 2), ("92d", 0)]
       if c[1] >= portal_conversations.VIP_THRESHOLD]
check("vip cut", [c[0] for c in vip] == ["92a", "92b"], vip)

sys.exit(1 if summary("vip") else 0)
