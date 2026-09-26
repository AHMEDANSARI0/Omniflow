"""Tests for webhook test + retry (Phases 186-190)."""
import sys

from flask import Flask

import portal_webhooks
import test_lib
from test_lib import (check, human_principal, install_db_stub, PrincipalStub,
                      status, summary)


app = Flask(__name__)
app.register_blueprint(portal_webhooks.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_webhooks, principal=human)

DDL = [[], [], [], []]


def fresh(script):
    portal_webhooks._WEBHOOK_DDL_READY = False
    conn = install_db_stub(portal_webhooks, script)
    return conn


class FakeResponse:
    def __init__(self, status):
        self.status = status


print("== test endpoint ==")

conn = fresh(DDL + [[{"id": 3, "url": "https://hooks.example/x", "secret": "s3cr3t"}], [], []])
portal_webhooks._http_post = lambda url, headers, body, timeout=5: FakeResponse(200)
response = client.post("/api/v1/portal/webhooks/3/test")
check("200 test", status(response) == 200, status(response))
check("delivered true", response.get_json()["delivered"] is True, response.get_json())
check("status echoed", response.get_json()["status_code"] == 200, response.get_json())
check("webhook guarded", conn.cur.executed[4][1][0] == 3, conn.cur.executed[4][1])
check("delivery recorded", "INSERT INTO" in conn.cur.executed[5][0]
      and "portal_webhook_deliveries" in conn.cur.executed[5][0], "insert")
check("ping event", "'ping'" in conn.cur.executed[5][0], "ping")
check("null action log", "action_log_id" in conn.cur.executed[5][0], "null log")

conn = fresh(DDL + [[{"id": 3, "url": "https://hooks.example/x", "secret": "s"}], []])
def boom(url, headers, body, timeout=5):
    raise OSError("conn refused")
portal_webhooks._http_post = boom
response = client.post("/api/v1/portal/webhooks/3/test")
check("down still 200", status(response) == 200, status(response))
check("delivered false", response.get_json()["delivered"] is False, response.get_json())
check("error surfaced", response.get_json()["error"] == "conn refused", response.get_json())

conn = fresh(DDL + [[]])
response = client.post("/api/v1/portal/webhooks/9/test")
check("404 unknown webhook", status(response) == 404, status(response))

print("== retry endpoint ==")

conn = fresh(DDL + [[{"id": 3}],
                    [{"id": 7, "event": "cod.confirmed", "payload": {"a": 1},
                      "attempts": 1, "delivered_at": None,
                      "url": "https://h/x", "secret": "s"}],
                    [], []])
portal_webhooks._http_post = lambda url, headers, body, timeout=5: FakeResponse(204)
response = client.post("/api/v1/portal/webhooks/3/deliveries/7/retry")
check("200 retry", status(response) == 200, status(response))
check("retry delivered", response.get_json()["delivered"] is True, response.get_json())
check("webhook guard first", "SELECT 1 FROM" in conn.cur.executed[4][0], "guard")
check("delivery guarded by webhook", "d.webhook_id = %s" in conn.cur.executed[5][0]
      and "d.client_id = %s" in conn.cur.executed[5][0], "scoped")
check("delivered update", "delivered_at = NOW()" in conn.cur.executed[6][0], "update")
check("retry commits", conn.committed is True, conn.committed)

conn = fresh(DDL + [[{"id": 3}],
                    [{"id": 7, "event": "x", "payload": {}, "attempts": 2,
                      "delivered_at": None, "url": "https://h/x", "secret": "s"}],
                    [], []])
portal_webhooks._http_post = boom
response = client.post("/api/v1/portal/webhooks/3/deliveries/7/retry")
check("failed retry 200", status(response) == 200, status(response))
check("failed retry delivered false", response.get_json()["delivered"] is False,
      response.get_json())
check("backoff update", "attempts = attempts + 1" in conn.cur.executed[6][0]
      and "make_interval" in conn.cur.executed[6][0], conn.cur.executed[6][0][:60])

conn = fresh(DDL + [[{"id": 3}],
                    [{"id": 7, "event": "x", "payload": {}, "attempts": 1,
                      "delivered_at": "2026-01-01", "url": "u", "secret": "s"}]])
response = client.post("/api/v1/portal/webhooks/3/deliveries/7/retry")
check("400 already delivered", status(response) == 400, status(response))

conn = fresh(DDL + [[{"id": 3}], []])
response = client.post("/api/v1/portal/webhooks/3/deliveries/99/retry")
check("404 unknown delivery", status(response) == 404, status(response))

conn = fresh(DDL + [[]])
response = client.post("/api/v1/portal/webhooks/8/deliveries/7/retry")
check("404 foreign webhook", status(response) == 404, status(response))

print("== poll still skips delivered ==")

src = open("/tmp/p13/OmniFlow-Control-Plane/portal_webhooks.py").read()
check("poll filter intact", "d.delivered_at IS NULL" in src
      and "attempts < %s" in src, "poll")

print("== portal clients ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("test client", "export async function testWebhook(" in lib_src, "client")
check("retry client", "export async function retryWebhookDelivery(" in lib_src, "client")
check("test posts", '"/test"' in lib_src, "test url")
check("retry url", '"/deliveries/" + String(deliveryId) + "/retry"' in lib_src, "retry url")
check("result carries error", "error: string | null" in lib_src, "type")

print("== bff routes ==")

test_bff = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/webhooks/[id]/test/route.ts"
).read()
check("test bff post", "export async function POST(" in test_bff, "POST")
check("test bff depth", test_bff.count("../") >= 7 * 3, test_bff.count("../"))
check("test bff 404", 'code: "not_found"' in test_bff, "404")

retry_bff = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/webhooks/[id]/deliveries/[did]/retry/route.ts"
).read()
check("retry bff post", "export async function POST(" in retry_bff, "POST")
check("retry bff depth", retry_bff.count("../") >= 9 * 3, retry_bff.count("../"))
check("retry bff both ids", "did" in retry_bff and "webhookId" in retry_bff, "params")

print("== integrations page ==")

page_src = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/integrations/page.tsx"
).read()
check("send test button", "Send test" in page_src, "button")
check("test posts to bff", '"/test"' in page_src and 'method: "POST"' in page_src, "submit")
check("test note states", "Test delivered" in page_src and "Test failed" in page_src, "note")
check("retry now button", "Retry now" in page_src, "retry button")
check("retry only undelivered", "delivery.deliveredAt ? null : (" in page_src, "gate")
check("log refresh after retry", "void showLog(webhookId)" in page_src, "refresh")
check("busy disabled", "disabled={testBusy}" in page_src, "busy")

summary("webhook_ops")
