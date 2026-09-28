"""Webhook route checks with a scripted DB and a stubbed shared ingest core."""

import hashlib
import hmac
import json

from flask import Flask

import connector_api
import portal_instagram
from test_lib import check, summary


class Cur:
    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.description = None
        self.rows = []

    def execute(self, sql, params=None):
        if not self.scripts:
            raise AssertionError("DB script exhausted")
        rowset = self.scripts.pop(0)
        if rowset:
            self.description = tuple((key,) for key in rowset[0])
            self.rows = [tuple(row[key] for key in rowset[0]) for row in rowset]
        else:
            self.description = None
            self.rows = []

    def fetchall(self):
        return list(self.rows)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Conn:
    def __init__(self, scripts):
        self.cur = Cur(scripts)

    def cursor(self):
        return self.cur

    def commit(self):
        pass

    def close(self):
        pass


class DB:
    def __init__(self, scripts):
        self.conn = Conn(scripts)
        self.CMD_TABLE = "portal_connector_commands"
        self.CONV_TABLE = "portal_conversations"
        self.MSGS_TABLE = "portal_messages"

    def ensure_tables(self):
        pass

    def _conn(self):
        return self.conn

    def _q(self, value):
        return value

    def rows(self, cur):
        if cur.description is None:
            return []
        keys = [item[0] for item in cur.description]
        return [dict(zip(keys, row)) for row in cur.fetchall()]

    def portal_unavailable(self, error, context):
        return ({"error": {"code": "db_unavailable", "message": context}},)


ACCOUNT = {
    "client_id": 42,
    "instagram_account_id": "1789",
    "page_id": "page-1",
    "app_secret": "app-secret",
    "access_token": "access-token",
    "verify_token": "verify-token",
    "enabled": True,
    "last_check_at": None,
    "last_error": None,
}


def signed_body(value):
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    digest = hmac.new(b"app-secret", raw, hashlib.sha256).hexdigest()
    return raw, "sha256=" + digest


print("== Instagram webhook routes ==")
app = Flask(__name__)
app.register_blueprint(portal_instagram.public_bp)
client = app.test_client()

original_db = portal_instagram.portal_db
original_normalize = connector_api.normalize_messages
original_ingest = connector_api.ingest_messages_for_tenant
original_ready = portal_instagram._DDL_READY
captured = []

try:
    portal_instagram._DDL_READY = True
    portal_instagram.portal_db = DB([[ACCOUNT]])
    response = client.get(
        "/api/v1/public/instagram/webhook?hub.mode=subscribe"
        "&hub.verify_token=verify-token&hub.challenge=challenge-42"
    )
    check("Meta verification challenge", response.status_code == 200
          and response.data == b"challenge-42", response.status_code)

    event = {
        "object": "instagram",
        "entry": [{"id": "1789", "messaging": [{
            "sender": {"id": "441"},
            "recipient": {"id": "1789"},
            "message": {"mid": "mid-1", "text": "hello"},
        }]}],
    }
    raw, signature = signed_body(event)
    portal_instagram.portal_db = DB([[ACCOUNT]])
    connector_api.normalize_messages = lambda items, default_channel: items
    connector_api.ingest_messages_for_tenant = (
        lambda tenant, items: captured.append((tenant, items)) or 1
    )
    response = client.post(
        "/api/v1/public/instagram/webhook",
        data=raw,
        headers={"Content-Type": "application/json",
                 "X-Hub-Signature-256": signature},
    )
    check("signed tenant ingest", response.status_code == 200
          and response.get_json()["inserted"] == 1, response.get_json())
    check("account resolves workspace", captured[0][0]["client_id"] == 42, captured)
    check("normalized message reaches shared core",
          captured[0][1][0]["id"] == "mid-1", captured)

    portal_instagram.portal_db = DB([[ACCOUNT]])
    response = client.post(
        "/api/v1/public/instagram/webhook",
        data=raw,
        headers={"Content-Type": "application/json",
                 "X-Hub-Signature-256": "sha256=" + "0" * 64},
    )
    check("invalid signature rejected", response.status_code == 403,
          response.status_code)
finally:
    portal_instagram.portal_db = original_db
    portal_instagram._DDL_READY = original_ready
    connector_api.normalize_messages = original_normalize
    connector_api.ingest_messages_for_tenant = original_ingest

summary("instagram_webhook")
