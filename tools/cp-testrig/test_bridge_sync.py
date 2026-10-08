"""§256 bridge drift - the laptop's runtime bridge (src/control_plane_bridge.py)
gained the Cloud API template support that only the mirror
(connector-bridge/control_plane_bridge.py) had, and the mirror is now an
exact copy of the runtime, so they can never drift apart again.

Checks: mirror == runtime byte for byte; each §256 block is present once;
the patcher's marker-guarded inserts rebuild the runtime from the pre-256
file and are idempotent (from tools/patchers/spec_256.json when present);
then the real bridge class with stubbed HTTP: send_template success /
not-configured / invalid payload, the 10-minute template sync (throttled,
fail-soft) and the unchanged unsupported-action path.
Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
"""
import importlib.util
import io
import json
import os
import re
import sys

from test_lib import check, summary

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))
RUNTIME = os.path.join(ROOT, "src", "control_plane_bridge.py")
MIRROR = os.path.join(ROOT, "connector-bridge", "control_plane_bridge.py")
SPEC = os.path.join(ROOT, "tools", "patchers", "spec_256.json")
MARKERS = ("def send_template_message(", "self.sync_message_templates()", 'action == "send_template"')


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


print("== mirror == runtime ==")
runtime = read(RUNTIME)
mirror = read(MIRROR)
check("connector-bridge mirror is an exact copy of the runtime bridge", runtime == mirror)
for marker in MARKERS:
    check("runtime has the §256 block once: " + marker, runtime.count(marker) == 1, runtime.count(marker))
check("runtime keeps its own media-group batching (never replaced whole)",
      all(s in runtime for s in ("def _next_group(self):", "def _send_group(self, group):",
                                 "def send_media_message(self, payload, adapter):",
                                 "def send_interactive_message(self, payload, adapter):")))

print("== patcher inserts ==")
if os.path.exists(SPEC):
    inserts = json.loads(read(SPEC)).get("inserts") or []
    entry = [item for item in inserts if item[0] == "src/control_plane_bridge.py"]
    check("spec carries the runtime-bridge inserts", len(entry) == 1 and len(entry[0][1]) == 3)
    blocks = entry[0][1] if entry else []
    base = runtime
    for marker, anchor, block in blocks:
        check("block text present exactly once: " + marker, base.count(block) == 1)
        base = base.replace(block, "", 1)
    check("without the blocks no marker is left (a real pre-256 file)",
          not any(m in base for m, _a, _b in blocks))

    def apply(text):
        added = 0
        for marker, anchor, block in blocks:
            if marker in text:
                continue
            hits = list(re.finditer(anchor, text, re.M))
            if len(hits) != 1:
                return None, added
            text = text[:hits[0].start()] + block + text[hits[0].start():]
            added += 1
        return text, added

    rebuilt, added = apply(base)
    check("inserts rebuild the runtime exactly from the pre-256 file", rebuilt == runtime and added == 3)
    again, added = apply(runtime)
    check("second run adds nothing (idempotent)", again == runtime and added == 0)
    moved, _ = apply(base.replace("    def run_due_commands(", "    def run_due_commands_renamed("))
    check("an unknown file layout writes nothing", moved is None)
else:
    print("  skip: spec_256.json not here (shipped repo) - insert replay not run")

print("== bridge behaviour ==")
os.environ["OMNIFLOW_SERVICE_KEY"] = "svc"
for name in ("OMNIFLOW_WA_CLOUD_URL", "OMNIFLOW_WA_TOKEN", "OMNIFLOW_WA_AUTH_HEADER", "OMNIFLOW_WA_AUTH_VALUE"):
    os.environ.pop(name, None)
spec = importlib.util.spec_from_file_location("of_runtime_bridge", RUNTIME)
B = importlib.util.module_from_spec(spec)
_stdout = sys.stdout
sys.stdout = io.StringIO()
try:
    spec.loader.exec_module(B)
    bridge = B.ControlPlaneBridge()
finally:
    sys.stdout = _stdout

acks = []
cp_posts = []
queue = []
sent = []
syncs = []


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def fake_urlopen(request, timeout=None):
    sent.append(request)
    if request.get_method() == "GET":
        return FakeResponse(json.dumps({"data": [
            {"name": "order_update", "language": "en", "status": "APPROVED", "category": "UTILITY"},
            {"name": "", "language": "en"}, "junk"]}).encode())
    return FakeResponse(b'{"messages":[{"id":"wamid.1"}]}')


B.urllib.request.urlopen = fake_urlopen
bridge.fetch_commands = lambda limit=10: [queue.pop(0)] if queue else []
bridge.acknowledge_command = lambda cid, ok, note=None, *a, **k: acks.append((cid, ok, note))
bridge.process_due_followups = lambda adapter: None
bridge.process_due_away = lambda adapter: None
bridge._request = lambda method, path, payload=None, timeout=None: (cp_posts.append((method, path, payload)) or (200, {}))


def run(command):
    queue.append(command)
    sys.stdout = io.StringIO()
    try:
        bridge.run_due_commands(adapter=None)
    finally:
        sys.stdout = _stdout
    return acks[-1]


TEMPLATE = {"external_user_id": "923001234567", "template_name": "order_update",
            "language_code": "ur", "parameters": ["Sana", "  ", 2500]}
cid, ok, note = run({"id": 1, "action": "send_template", "payload": TEMPLATE})
check("send_template without Cloud API env -> failed with the reason (never acked done)",
      ok is False and "Cloud API not configured" in note and not sent, note)
check("template sync skipped quietly without Cloud API env", syncs == [] and not cp_posts)

os.environ["OMNIFLOW_WA_CLOUD_URL"] = "https://graph.facebook.com/v21.0/PHONE1/messages"
os.environ["OMNIFLOW_WA_TOKEN"] = "wa-tok"
cid, ok, note = run({"id": 2, "action": "send_template", "payload": TEMPLATE})
posted = [r for r in sent if r.get_method() == "POST"]
body = json.loads(posted[-1].data.decode()) if posted else {}
check("send_template -> one Cloud API template POST, acked done",
      ok is True and note == "Template sent via Cloud API." and len(posted) == 1
      and posted[0].full_url == "https://graph.facebook.com/v21.0/PHONE1/messages/", (ok, note))
check("template payload: recipient, name, language, blank params dropped",
      body.get("to") == "923001234567" and body["template"]["name"] == "order_update"
      and body["template"]["language"] == {"code": "ur"}
      and body["template"]["components"] == [{"type": "body", "parameters": [
          {"type": "text", "text": "Sana"}, {"type": "text", "text": "2500"}]}], body)
check("Bearer token header from env (never hardcoded)",
      posted and posted[0].get_header("Authorization") == "Bearer wa-tok")

cid, ok, note = run({"id": 3, "action": "send_template", "payload": {"external_user_id": "92300"}})
check("template without a name -> failed, nothing sent", ok is False and "Invalid template payload" in note
      and len([r for r in sent if r.get_method() == "POST"]) == 1, note)
cid, ok, note = run({"id": 4, "action": "make_coffee", "payload": {}})
check("unsupported actions still fail the same way", ok is False and note == "Unsupported action on connector: make_coffee")

print("== template sync ==")
sent.clear()
cp_posts.clear()
bridge._last_template_sync = 0.0
run({"id": 5, "action": "connect"})
gets = [r for r in sent if r.get_method() == "GET"]
check("template list read from the WABA templates edge",
      len(gets) == 1 and gets[0].full_url == "https://graph.facebook.com/v21.0/PHONE1/message_templates?limit=200",
      [r.full_url for r in gets])
check("clean list pushed to the portal snapshot",
      cp_posts == [("POST", "/api/v1/connector/cloud-templates/sync", {"client_id": bridge.client_id, "templates": [
          {"name": "order_update", "language": "en", "status": "APPROVED", "category": "UTILITY"}]})], cp_posts)
run({"id": 6, "action": "connect"})
check("synced at most every 10 minutes", len([r for r in sent if r.get_method() == "GET"]) == 1)


def broken():
    raise RuntimeError("network down")


bridge._last_template_sync = 0.0
bridge.sync_message_templates = broken
cid, ok, note = run({"id": 7, "action": "connect"})
check("a failing sync never blocks commands", cid == 7 and ok is True)

sys.exit(1 if summary("bridge_sync") else 0)
