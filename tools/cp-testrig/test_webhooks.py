"""Tests for outbound webhooks (Phases 151-155)."""
import sys

from flask import Flask

import portal_webhooks
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_webhooks.bp)
client = app.test_client()

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_webhooks, principal=human)

DDL_SLOTS = [[], [], [], []]


def fresh(script):
    portal_webhooks._WEBHOOK_DDL_READY = False
    return install_db_stub(portal_webhooks, DDL_SLOTS + script)


print("== validation ==")

check("https ok", portal_webhooks._valid_webhook_url("https://x.example/hook") == "https://x.example/hook")
check("localhost ok", portal_webhooks._valid_webhook_url("http://localhost:9000/h") is not None)
check("http rejected", portal_webhooks._valid_webhook_url("http://evil.example/h") is None)
check("junk rejected", portal_webhooks._valid_webhook_url("not a url") is None)
check("events default all", portal_webhooks._normalize_events(None) == "all")
check("events csv ok", portal_webhooks._normalize_events("cod,broadcast") == "cod,broadcast")
check("events bad rejected", portal_webhooks._normalize_events("weird") is None)

print("== create + list ==")

HOOK_ROW = {"id": 3, "url": "https://x.example/hook", "events": "all",
            "enabled": True, "created_at": None,
            "last_delivery_at": None, "last_status_code": None}
conn = fresh([[HOOK_ROW]])
response = client.get("/api/v1/portal/webhooks")
check("200 list", status(response) == 200
      and response.get_json()["webhooks"][0]["id"] == 3, status(response))

conn = fresh([[{"id": 3, "url": "https://x.example/hook", "events": "all",
                "enabled": True, "created_at": None}], []])
response = client.post("/api/v1/portal/webhooks",
                       json={"url": "https://x.example/hook", "events": "all"})
check("200 create", status(response) == 200, status(response))
secret = response.get_json().get("webhook", {}).get("secret")
check("secret returned once", isinstance(secret, str) and len(secret) == 48, secret)
check("audit logged", conn.cur.executed[5][1][1] == "webhooks.created", conn.cur.executed[5][1])

response = client.post("/api/v1/portal/webhooks", json={"url": "http://nope.example"})
check("400 bad url", status(response) == 400, status(response))

print("== update + delete + deliveries ==")

conn = fresh([[{"id": 3}]])
response = client.put("/api/v1/portal/webhooks/3", json={"enabled": False})
check("200 update", status(response) == 200, status(response))
check("update sets enabled", "enabled = %s" in conn.cur.executed[4][0], conn.cur.executed[4][0][-80:])

conn = fresh([[]])
response = client.put("/api/v1/portal/webhooks/99", json={"enabled": True})
check("404 update unknown", status(response) == 404, status(response))

conn = fresh([[{"id": 3}], [{"id": 3}]])
response = client.delete("/api/v1/portal/webhooks/3")
check("200 delete", status(response) == 200, status(response))
check("deletes deliveries first", "DELETE FROM" in conn.cur.executed[4][0]
      and "portal_webhook_deliveries" in conn.cur.executed[4][0])

conn = fresh([[{"1": 1}], []])
response = client.get("/api/v1/portal/webhooks/3/deliveries")
check("200 deliveries", status(response) == 200
      and response.get_json()["deliveries"] == [], status(response))

conn = fresh([[]])
response = client.get("/api/v1/portal/webhooks/77/deliveries")
check("404 foreign webhook", status(response) == 404, status(response))

print("== dispatch: enqueue ==")

LOG = {"id": 41, "action": "cod.confirmed", "conversation_id": 9,
       "note": "COD request 12 replied confirmed.", "created_at": None}
HOOKS = [{"id": 3, "events": "all"}, {"id": 4, "events": "broadcast"}]
conn = fresh([[LOG], HOOKS, [None], []])
portal_webhooks.deliver_pending_webhooks(conn.cur, 1, conn)
inserts = [e for e in conn.cur.executed if "INSERT INTO" in e[0]]
check("one insert per matching hook", len(inserts) == 1, len(inserts))
check("payload carries event", '"cod"' in str(inserts[0][1]), inserts[0][1])

conn = fresh([[], [], []])
portal_webhooks.deliver_pending_webhooks(conn.cur, 1, conn)
check("no logs no writes", len(conn.cur.executed) == 6, len(conn.cur.executed))

print("== dispatch: delivery attempts ==")

class FakeResponse:
    status = 200

PENDING = [{"id": 9, "event": "cod", "payload": {"x": 1}, "attempts": 0,
            "url": "https://x.example/hook", "secret": "s3cret"}]
calls = []
def ok_post(url, headers, body, timeout=5):
    calls.append({"url": url, "headers": headers, "body": body})
    return FakeResponse()

conn = fresh([[], PENDING, []])
portal_webhooks._http_post = ok_post
result = portal_webhooks.deliver_pending_webhooks(conn.cur, 1, conn)
check("delivered count 1", result == 1, result)
check("signature header", calls[0]["headers"]["X-Omniflow-Signature"].startswith("sha256=")
      and len(calls[0]["headers"]["X-Omniflow-Signature"]) == 71, calls[0]["headers"])
check("event header", calls[0]["headers"]["X-Omniflow-Event"] == "cod")
check("marked delivered", "delivered_at = NOW()" in conn.cur.executed[6][0])
check("committed", conn.committed is True)

def boom(url, headers, body, timeout=5):
    raise OSError("connection refused")

PENDING_RETRY = [{"id": 10, "event": "cod", "payload": {}, "attempts": 2,
                  "url": "https://x.example/hook", "secret": "s3cret"}]
conn = fresh([[], PENDING_RETRY, []])
portal_webhooks._http_post = boom
result = portal_webhooks.deliver_pending_webhooks(conn.cur, 1, conn)
check("failure delivered 0", result == 0, result)
update = [e for e in conn.cur.executed if "UPDATE" in e[0]][0]
check("backoff grows", "make_interval(mins => %s)" in update[0]
      and update[1][2] == 6, update[1])
check("error recorded", "connection refused" in str(update[1][1]), update[1])
portal_webhooks._http_post = ok_post

print("== structural ==")
app_src = open("/tmp/p13/OmniFlow-Control-Plane/app.py").read()
check("app registers webhooks", "register_blueprint(portal_webhooks_bp)" in app_src)
conn_src = open("/tmp/p13/OmniFlow-Control-Plane/connector_api.py").read()
check("poll dispatches", "deliver_pending_webhooks(" in conn_src
      and conn_src.index("deliver_pending_webhooks(") > conn_src.index("materialize_due_broadcasts("))
module_src = open("/tmp/p13/OmniFlow-Control-Plane/portal_webhooks.py").read()
check("unique dedupe index", "uq_webhook_delivery" in module_src)
check("signature hmac", "hmac.new" in module_src and "sha256" in module_src)
lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib clients", "export async function listWebhooks(" in lib_src
      and "export async function deleteWebhook(" in lib_src)
bff1 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/webhooks/route.ts").read()
bff2 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/webhooks/[id]/route.ts").read()
bff3 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/webhooks/[id]/deliveries/route.ts").read()
check("bff depths", bff1.count("../") == 15 and bff2.count("../") == 18
      and bff3.count("../") == 14, (bff1.count("../"), bff2.count("../"), bff3.count("../")))
page_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/integrations/page.tsx").read()
check("page secret once", "shown once" in page_src)
check("page delivery log", "Deliveries" in page_src)
nav_src = open("/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx").read()
check("nav item", 'href: "/dashboard/integrations"' in nav_src)

failures = summary("webhooks")
sys.exit(1 if failures else 0)
