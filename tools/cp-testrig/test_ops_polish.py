"""Ops polish (§205): human-reply auto-resolve, workflow versions/rollback,
tenant BI thresholds + business_hours timezone for busy hours."""
import os
import sys

# Running as a file puts this directory first on sys.path and would shadow the
# real Control Plane modules with the rig reconstructions - put the patch first
# and drop this folder from the front so portal_conversations.py is the real one.
_HERE = os.path.abspath(os.path.dirname(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CP = os.path.join(_ROOT, "omniflow-backend-patch")
sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
sys.path.insert(0, _CP)
sys.path.append(_HERE)  # test_lib still needs to import

from flask import Flask

import portal_auth
import portal_bi as bi
import portal_conversations as conv
import portal_workflows as wf
from test_lib import check, install_db_stub, summary

assert "omniflow-backend-patch" in (conv.__file__ or ""), conv.__file__

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY = dict(PRINCIPAL, via_api_key=True)


class PrincipalStub:
    def __init__(self, module, principal):
        self.module = module
        self.principal = principal

    def __enter__(self):
        self.orig = getattr(self.module, "authenticate_portal_request", None)
        self.module.authenticate_portal_request = lambda: self.principal
        if hasattr(self.module, "PortalAuthUnavailable"):
            self.module.PortalAuthUnavailable = Exception
        return self

    def __exit__(self, *a):
        if self.orig is not None:
            self.module.authenticate_portal_request = self.orig


def run_api(module, script, method, path, principal=PRINCIPAL, json_body=None):
    install_db_stub(module, script)
    app = Flask("ops-polish")
    app.register_blueprint(module.bp)
    with PrincipalStub(module, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "PUT":
            return client.put(path, json=json_body or {})
        return client.post(path, json=json_body or {})


print("== human reply auto-resolve ==")
import portal_escalation as pe
_orig_resolve = pe.resolve_for_conversation
pe.resolve_for_conversation = (
    lambda cur, client_id, conversation_id, user_id=None, note="": 2
)
try:
    # SELECT conv, INSERT cmd RETURNING, log_action INSERT
    # (resolve is mocked so its DDL/UPDATE does not consume the script)
    script = [
        [{"id": 42, "contact_id": "923001111111", "contact_name": "Ali",
          "channel": "whatsapp"}],
        [{"id": 9001}],
        [],
    ]
    r = run_api(conv, script, "POST", "/api/v1/portal/conversations/42/messages",
                json_body={"body": "We are on it."})
    check("POST conversation reply 200 queued",
          r.status_code == 200 and (r.get_json() or {}).get("queued") is True
          and (r.get_json() or {}).get("command_id") == 9001
          and (r.get_json() or {}).get("resolved_escalations") == 2, r.get_json())

    r = run_api(conv, [], "POST", "/api/v1/portal/conversations/42/messages",
                json_body={"body": "  "})
    check("POST reply empty body 400", r.status_code == 400, r.status_code)

    r = run_api(conv, [], "POST", "/api/v1/portal/conversations/42/messages",
                principal=API_KEY, json_body={"body": "Hi"})
    check("POST reply 403 for API key", r.status_code == 403, r.status_code)

    r = run_api(conv, [[]], "POST", "/api/v1/portal/conversations/99/messages",
                json_body={"body": "Hi"})
    check("POST reply 404 missing conversation", r.status_code == 404, r.status_code)
finally:
    pe.resolve_for_conversation = _orig_resolve


print("== workflow versions / rollback ==")
wf._ensure_ddl = lambda cur: None
snap = {
    "name": "Welcome", "description": "d", "trigger_type": "manual",
    "trigger_config": {}, "stop_on_reply": False,
    "steps": [{"kind": "stop", "label": "End", "config": {}}],
}
script = [
    [{"id": 5}],
    [{"version": 2, "snapshot": snap, "created_at": None},
     {"version": 1, "snapshot": snap, "created_at": None}],
]
r = run_api(wf, script, "GET", "/api/v1/portal/workflows/5/versions")
check("GET workflow versions 200", r.status_code == 200
      and len((r.get_json() or {}).get("versions") or []) == 2
      and (r.get_json() or {})["versions"][0]["version"] == 2, r.get_json())

script = [
    [{"version": 1, "snapshot": snap, "created_at": None}],
    [{"version": 3}],
    [],
    [],
    [],
    [],
]
r = run_api(wf, script, "POST", "/api/v1/portal/workflows/5/rollback",
            json_body={"version": 1})
check("POST workflow rollback 200", r.status_code == 200
      and (r.get_json() or {}).get("ok") is True
      and (r.get_json() or {}).get("version") == 3
      and (r.get_json() or {}).get("restored_from") == 1, r.get_json())

r = run_api(wf, [], "POST", "/api/v1/portal/workflows/5/rollback",
            json_body={"version": 0})
check("POST rollback bad version 400", r.status_code == 400, r.status_code)

r = run_api(wf, [], "GET", "/api/v1/portal/workflows/5/versions",
            principal=API_KEY)
check("GET versions 403 API key", r.status_code == 403, r.status_code)


print("== BI thresholds + timezone ==")
check("clamp share/min/csat", bi._clamp_threshold("handoff_share", 1.5) == 1.0
      and bi._clamp_threshold("gaps_min", -3) == 1.0
      and bi._clamp_threshold("csat_low", 0) == 1.0, "-")

install_db_stub(bi, [[{"bi_thresholds": {"handoff_share": 0.1, "gaps_min": 20}}]])
conn = bi.portal_db._conn()
with conn.cursor() as cur:
    T = bi.thresholds_for(cur, 1)
check("thresholds_for overlays owner values",
      T["handoff_share"] == 0.1 and T["gaps_min"] == 20.0
      and T["topic_min"] == bi.THRESHOLDS["topic_min"], T)

install_db_stub(bi, [[{"business_hours": {"timezone": "Asia/Karachi", "enabled": False}}]])
conn = bi.portal_db._conn()
with conn.cursor() as cur:
    off = bi.timezone_offset_hours(cur, 1)
check("timezone_offset_hours from business_hours", off == 5, off)

script = [
    [{"bi_thresholds": {}}],
    [{"business_hours": {"timezone": "UTC"}}],
]
r = run_api(bi, script, "GET", "/api/v1/portal/bi/thresholds")
check("GET bi/thresholds 200", r.status_code == 200
      and "thresholds" in (r.get_json() or {})
      and "defaults" in (r.get_json() or {})
      and "keys" in (r.get_json() or {}), r.get_json())

script = [
    [],
    [{"bi_thresholds": {"handoff_share": 0.4}}],
    [],
    [],
    [{"bi_thresholds": {"handoff_share": 0.55}}],
]
r = run_api(bi, script, "PUT", "/api/v1/portal/bi/thresholds",
            json_body={"thresholds": {"handoff_share": 0.55}})
check("PUT bi/thresholds 200", r.status_code == 200
      and (r.get_json() or {}).get("ok") is True
      and abs((r.get_json() or {}).get("thresholds", {}).get("handoff_share", 0) - 0.55) < 1e-9,
      r.get_json())

r = run_api(bi, [], "PUT", "/api/v1/portal/bi/thresholds",
            principal=API_KEY, json_body={"thresholds": {"gaps_min": 3}})
check("PUT bi/thresholds 403 API key", r.status_code == 403, r.status_code)


print("== source pins ==")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")


def read(rel):
    path = os.path.join(ROOT, rel)
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


check("conversation reply endpoint present",
      "def send_conversation_message" in read("omniflow-backend-patch/portal_conversations.py"), "-")
check("workflow rollback endpoint present",
      "def rollback_workflow" in read("omniflow-backend-patch/portal_workflows.py"), "-")
check("BI thresholds endpoints present",
      "bi/thresholds" in read("omniflow-backend-patch/portal_bi.py"), "-")
check("website BFF routes present",
      bool(read("app/api/omniflow/portal/workflows/[id]/versions/route.ts"))
      and bool(read("app/api/omniflow/portal/workflows/[id]/rollback/route.ts"))
      and bool(read("app/api/omniflow/portal/bi/thresholds/route.ts")), "-")
check("settings card + workflows history UI",
      "BiThresholdsCard" in read("app/dashboard/(portal)/settings/page.tsx")
      and "Version history" in read("app/dashboard/(portal)/workflows/WorkflowsClient.tsx"), "-")
check("portal.ts helpers",
      "listWorkflowVersions" in read("lib/omniflow/portal.ts")
      and "getBiThresholds" in read("lib/omniflow/portal.ts")
      and "sendConversationMessage" in read("lib/omniflow/portal.ts"), "-")
check("resolve_for_conversation still fail-soft",
      "def resolve_for_conversation" in read("omniflow-backend-patch/portal_escalation.py"), "-")

raise SystemExit(1 if summary("ops_polish") else 0)
