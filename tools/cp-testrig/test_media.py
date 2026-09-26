"""Tests for B11: portal_media (library upload/list/download/delete,
send_media command queueing + opt-out + thread row, connector
download guard, STT env config + multipart + flows) + wiring pins."""
import io
import json

from flask import Flask

import portal_media
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


def fresh(script, env=None):
    portal_media._DDL_READY = False
    portal_media.os.environ.pop("OMNIFLOW_STT_API_KEY", None)
    portal_media.os.environ.pop("OMNIFLOW_STT_BASE", None)
    portal_media.os.environ.pop("OMNIFLOW_STT_MODEL", None)
    for key, value in (env or {}).items():
        portal_media.os.environ[key] = value
    conn = install_db_stub(portal_media, script)
    portal_media.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


def run_api(script, method, path, json_body=None, principal=PRINCIPAL,
            env=None, data=None, headers=None):
    fresh(script, env)
    app = Flask("media-test")
    app.register_blueprint(portal_media.bp)
    app.register_blueprint(portal_media.connector_bp)
    with PrincipalStub(portal_media, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path, headers=headers)
        if method == "POST":
            if data is not None:
                return client.post(path, data=data,
                                   content_type="multipart/form-data")
            return client.post(path, json=json_body, headers=headers)
    return None


ASSET = {"id": 5, "kind": "image", "filename": "pic.png",
         "mime": "image/png", "size_bytes": 12, "caption": "",
         "created_at": "t"}
AUDIO = dict(ASSET, id=7, kind="audio", filename="note.ogg",
             mime="audio/ogg", content=b"oggdata")

# ---------- kind rules ----------

check("png is image", portal_media.kind_for_mime("image/png")
      == "image", "img")
check("jpeg prefix", portal_media.kind_for_mime("image/jpeg")
      == "image", "jpg")
check("pdf is document", portal_media.kind_for_mime("application/pdf")
      == "document", "pdf")
check("ogg is audio", portal_media.kind_for_mime("audio/ogg;codecs=opus"
                                                 .split(";")[0]) == "audio",
      "ogg")
check("exe rejected", portal_media.kind_for_mime(
    "application/x-msdownload") is None, "exe")
check("empty rejected", portal_media.kind_for_mime("") is None, "empty")

# ---------- upload ----------

r = run_api([], "POST", "/api/v1/portal/media")
check("upload 400 no file", r.status_code == 400, r.status_code)

RETURNING = [{"id": 5, "kind": "image", "filename": "pic.png",
              "mime": "image/png", "size_bytes": 14,
              "caption": "catalog", "created_at": "t"}]
conn = fresh([[], RETURNING, []])
app = Flask("m1"); app.register_blueprint(portal_media.bp)
with PrincipalStub(portal_media, PRINCIPAL):
    r = app.test_client().post(
        "/api/v1/portal/media",
        data={"caption": "catalog",
              "file": (io.BytesIO(b"hello-world-png"), "pic.png",
                       "image/png")})
body = r.get_json()
check("upload 200", r.status_code == 200
      and body["asset"]["kind"] == "image"
      and body["asset"]["size_bytes"] == 14, body)
check("upload insert has BYTEA param", any(
    "portal_media_assets" in e[0] and "hello-world-png" in
    json.dumps([str(q) for q in (e[1] or [])])
    for e in conn.cur.executed), "bytes")
check("upload audited", any("media.uploaded" in str(e)
                            for e in conn.cur.executed), "audit")

with PrincipalStub(portal_media, PRINCIPAL):
    r = app.test_client().post(
        "/api/v1/portal/media",
        data={"file": (io.BytesIO(b"MZ"), "evil.exe",
                       "application/x-msdownload")})
check("upload bad mime 400", r.status_code == 400, r.status_code)

r = run_api([], "POST", "/api/v1/portal/media", principal=dict(
    PRINCIPAL, via_api_key=True))
check("upload api key 403", r.status_code == 403, r.status_code)

# ---------- list / delete ----------

r = run_api([[], [ASSET, AUDIO]], "GET",
            "/api/v1/portal/media")
body = r.get_json()
check("list 2 assets", len(body["assets"]) == 2
      and body["assets"][0]["id"] == 5, body)
check("list has no content key", "content" not in body["assets"][0],
      body)

r = run_api([[], [{"id": 5}], []], "POST",
            "/api/v1/portal/media/delete", {"id": 5})
check("delete 200", r.status_code == 200, r.status_code)
r = run_api([[], []], "POST", "/api/v1/portal/media/delete", {"id": 9})
check("delete 404", r.status_code == 404, r.status_code)
r = run_api([], "POST", "/api/v1/portal/media/delete", {})
check("delete 400 no id", r.status_code == 400, r.status_code)

# ---------- send (command queue + optout + thread row) ----------

r = run_api([[], [ASSET]], "POST", "/api/v1/portal/media/send",
            {"id": 5})
check("send 400 no contact", r.status_code == 400, r.status_code)

conn = fresh([[], [ASSET], [], [], [], []])
app = Flask("m2"); app.register_blueprint(portal_media.bp)
with PrincipalStub(portal_media, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/media/send", json={
        "id": 5, "contact_id": "92300", "conversation_id": 42,
        "caption": "catalog"})
check("send 200 queued", r.status_code == 200
      and r.get_json()["queued"] is True, r.get_json())
execs = json.dumps([list(e) for e in conn.cur.executed])
check("send command send_media", "send_media" in execs
      and "portal_connector_commands" in execs, "cmd")
check("send payload has asset + contact", "asset_id" in execs
      and "92300" in execs and "42" in execs, "payload")
check("send thread row + audit", "portal_messages" in execs
      and "media.sent" in execs, "row")

conn = fresh([[], [ASSET], [{"1": 1}]])
app = Flask("m3"); app.register_blueprint(portal_media.bp)
with PrincipalStub(portal_media, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/media/send", json={
        "id": 5, "contact_id": "92300"})
check("send opted out 409", r.status_code == 409
      and r.get_json()["error"]["code"] == "opted_out", r.get_json())

r = run_api([[], []], "POST", "/api/v1/portal/media/send",
            {"id": 99, "contact_id": "92300"})
check("send 404 unknown asset", r.status_code == 404, r.status_code)

# ---------- connector download (machine) ----------

r = run_api([], "GET", "/api/v1/connector/media/5")
check("connector 401 no key", r.status_code == 401, r.status_code)


class FakeResp:
    data = b"raw"
    status_code = 200


def test_connector_guard(env_key, header_key):
    fresh([[], [dict(ASSET, content=b"raw")]],
          {"OMNIFLOW_SERVICE_KEY": env_key})
    app = Flask("m4")
    app.register_blueprint(portal_media.connector_bp)
    headers = {"X-Omniflow-Key": header_key} if header_key else {}
    return app.test_client().get(
        "/api/v1/connector/media/5?client_id=1", headers=headers)


r = test_connector_guard("svc", "svc")
check("connector 200 with key", r.status_code == 200
      and r.data == b"raw", r.status_code)
r = test_connector_guard("svc", "wrong")
check("connector 401 bad key", r.status_code == 401, r.status_code)

# ---------- transcription ----------

r = run_api([[], [AUDIO]], "POST", "/api/v1/portal/media/transcribe",
            {"id": 7})
check("transcribe 409 no key", r.status_code == 409
      and r.get_json()["error"]["code"] == "stt_not_configured",
      r.get_json())

CALLS = []


def fake_urlopen(req, timeout=0):
    CALLS.append({"url": req.full_url,
                  "body": req.data,
                  "headers": dict(req.header_items())})

    class R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"text": "Order confirm karein"}).encode()

    return R()


portal_media.urllib.request.urlopen = fake_urlopen

r = run_api([[], [AUDIO], [], []], "POST",
            "/api/v1/portal/media/transcribe", {"id": 7},
            env={"OMNIFLOW_STT_API_KEY": "sk-test"})
check("transcribe 200 text", r.status_code == 200
      and r.get_json()["text"] == "Order confirm karein", r.get_json())
check("transcribe hits /audio/transcriptions", CALLS
      and CALLS[0]["url"].endswith("/audio/transcriptions"), CALLS[:1])
check("transcribe multipart model", b"whisper-1" in CALLS[0]["body"]
      and b"note.ogg" in CALLS[0]["body"], "multipart")
check("transcribe bearer", any("Bearer sk-test" in str(v)
                               for v in CALLS[0]["headers"].values()),
      "auth")

r = run_api([[], [ASSET], [], []], "POST",
            "/api/v1/portal/media/transcribe", {"id": 5},
            env={"OMNIFLOW_STT_API_KEY": "sk-test"})
check("transcribe image 400", r.status_code == 400, r.status_code)

r = run_api([], "POST", "/api/v1/portal/media/transcribe", {},
            env={"OMNIFLOW_STT_API_KEY": "sk-test"})
check("transcribe 400 no id", r.status_code == 400, r.status_code)

# ---------- wiring pins ----------

APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers media bps",
      "portal_media_bp" in APP and "portal_media_connector_bp" in APP,
      "bps")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("listMediaAssets", "uploadMediaAsset", "deleteMediaAsset",
           "sendMediaAsset", "transcribeMediaAsset"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
BASE = "/tmp/smoke971/"
for name, needle in (("bff_media", "listMediaAssets"),
                     ("bff_media_delete", "deleteMediaAsset"),
                     ("bff_media_send", "sendMediaAsset"),
                     ("bff_media_transcribe", "transcribeMediaAsset")):
    src = open(BASE + name + ".ts", encoding="utf8").read()
    check("bff " + name, "export async function" in src
          and needle in src, name)
DOWNLOAD = open(BASE + "bff_media_download.ts", encoding="utf8").read()
check("bff download streams", "arrayBuffer" in DOWNLOAD
      or "bytes()" in DOWNLOAD, DOWNLOAD[:80])
PAGE = open(BASE + "media_page.tsx", encoding="utf8").read()
check("media page", "Upload" in PAGE and "Transcribe" in PAGE
      and "media/upload".replace("media/", "") in PAGE, "page")
SIDEBAR = open(BASE + "sidebar.tsx", encoding="utf8").read()
check("sidebar media nav", "/dashboard/media" in SIDEBAR, "nav")
BRIDGE = open("/tmp/p13/src/control_plane_bridge.py",
              encoding="utf8").read()
check("bridge send_media branch", 'action == "send_media"' in BRIDGE,
      "branch")
check("bridge media helper", "def send_media_message" in BRIDGE,
      "helper")
check("bridge multipart upload", "/media" in BRIDGE
      and "messaging_product" in BRIDGE, "cloud")

summary("media")
