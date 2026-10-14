"""§230 AI Sandbox - rolled-back runs of the real ingest path.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
Units (input rules, savepoint proxy, outside-call guard, hooks in
portal_db / portal_ratelimit / portal_ai_usage / portal_brain, result
shaping, expectations), source + web pins, then the real thing on
`pgserver` (PostgreSQL 16): the production ingest + AI brain against a fake
model, proving nothing persists, nothing leaves, a COMMIT is impossible,
hook commits stay inside the run, flags are restored, workflows are
simulated and the HTTP API (roles, saved tests) works. The database half
is skipped when pgserver is missing.
"""
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_lib import check, summary

# fake model endpoint first: portal_llm reads its base URL at import time
SEEN = []
REPLY = {"reply": "Ji haan, COD available hai.", "needs_human": False, "confidence": 0.92}


class _Model(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        SEEN.append((self.path, json.loads(raw or b"{}")))
        out = json.dumps({"choices": [{"message": {"content": json.dumps(REPLY)}}],
                          "usage": {"prompt_tokens": 40, "completion_tokens": 9}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST


MODEL = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
threading.Thread(target=MODEL.serve_forever, daemon=True).start()
MODEL_URL = "http://127.0.0.1:%d" % MODEL.server_address[1]

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in list(os.environ):
    if name.startswith(("OF_SANDBOX_", "OF_LLM_", "OF_ROUTER_")):
        os.environ.pop(name)
os.environ.update({"OF_LLM_BASE_URL": MODEL_URL + "/v1", "OF_LLM_API_KEY": "k-test",
                   "OF_LLM_ENABLED": "1"})
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))
CP = os.getcwd()

import portal_db  # noqa: E402
import portal_sandbox as sb  # noqa: E402
import portal_ai_usage  # noqa: E402
import portal_brain  # noqa: E402
import portal_ratelimit  # noqa: E402
import portal_channels  # noqa: E402


def src(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


# ---------------------------------------------------------------------------
print("== input rules ==")
ok, why = sb.clean_input({"message": "  ", "channel": "whatsapp"})
check("empty message refused", ok is None and "message" in why, why)
ok, why = sb.clean_input({"message": "x" * 2001})
check("long message refused", ok is None, why)
ok, why = sb.clean_input({"message": "hi", "channel": "website"})
check("unknown channel refused", ok is None and "channel" in why, why)
ok, why = sb.clean_input({"message": "hi", "history": "nope"})
check("history must be a list", ok is None, why)
ok, why = sb.clean_input({"message": "hi", "history": [{"role": "customer", "text": "a"}] * 13})
check("history capped (12)", ok is None and "12" in why, why)
ok, why = sb.clean_input({"message": "hi", "history": [{"role": "bot", "text": "a"}]})
check("history role checked", ok is None, why)
ok, why = sb.clean_input({"message": " COD? ", "history": [{"role": "Business", "text": " hi "}],
                          "force_auto": "yes"})
check("clean defaults", ok == {"message": "COD?", "channel": "whatsapp",
                               "customer_name": "Test Customer",
                               "history": [{"role": "business", "text": "hi"}],
                               "force_auto": False, "simulate_workflows": True}, ok)
ok, _ = sb.clean_input({"message": "x", "force_auto": True, "simulate_workflows": False})
check("force_auto only when exactly true", ok["force_auto"] is True and ok["simulate_workflows"] is False)
check("env clamp", sb._env_int("NOPE_X", 5, 1, 3) == 3)
for option, (channel, prefix, suffix) in sb.CHANNELS.items():
    check("contact prefix routes to its adapter: " + option,
          portal_channels.channel_for_contact(prefix + "123" + suffix) == channel)
check("defaults", sb.ROLES == ("owner", "admin") and sb.RUNS_PER_HOUR == 60
      and sb.MAX_HISTORY == 12 and sb.TX_SECONDS == 90, (sb.ROLES, sb.RUNS_PER_HOUR))

# ---------------------------------------------------------------------------
print("== hooks (inactive outside a run) ==")
check("inactive by default", sb.active() is False and sb.autonomy_override("suggest") == "suggest")
check("usage not captured outside", sb.capture_usage(1, "brain", "m", 1, 1, 1, True) is False)


class FakeCur:
    def __init__(self, log, fail_on=()):
        self.log, self.fail_on = log, fail_on

    def execute(self, sql, params=None):
        self.log.append(sql)
        if any(sql.startswith(f) for f in self.fail_on):
            self.fail_on = ()
            raise RuntimeError("aborted")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeConn:
    def __init__(self, fail_on=()):
        self.log, self.fail_on = [], fail_on

    def cursor(self, *a, **k):
        cur = FakeCur(self.log, self.fail_on)
        self.fail_on = ()
        return cur


run = sb._Run(FakeConn(), True)
token = sb._STATE.set(run)
try:
    check("active in run", sb.active() is True)
    check("suggest lifted to auto", sb.autonomy_override("suggest") == "auto")
    check("off never lifted", sb.autonomy_override("off") == "off")
    check("brain: kill switch still wins",
          portal_brain.effective_autonomy("suggest", {"kill_switch": True}) == "off")
    check("brain: platform cap still wins",
          portal_brain.effective_autonomy("suggest", {"autonomy_cap": "suggest"}) == "suggest")
    check("brain: lifted under no cap",
          portal_brain.effective_autonomy("suggest", {"autonomy_cap": "auto"}) == "auto")
    real_conn = portal_db._conn
    portal_db._conn = lambda: (_ for _ in ()).throw(AssertionError("no DB in a run"))
    try:
        check("ledger buffered (no DB write)",
              portal_ai_usage.record(4, "brain", "gpt", 10, 5, 120, True, agent_id=2, route="fast") is True
              and run.usage[-1] == {"client_id": 4, "feature": "brain", "model": "gpt",
                                    "prompt_tokens": 10, "completion_tokens": 5, "latency_ms": 120,
                                    "ok": True, "agent_id": 2}, run.usage)
    finally:
        portal_db._conn = real_conn
    touched = []
    check("rate limit skipped (no cursor touched)",
          portal_ratelimit.allow(FakeCur(touched), "k", 0, 1) is True and touched == [], touched)
finally:
    sb._STATE.reset(token)
run.force_auto = False
token = sb._STATE.set(run)
check("no lift without Pretend Auto", sb.autonomy_override("suggest") == "suggest")
sb._STATE.reset(token)

made = []
tok = portal_db.SANDBOX_CONN.set(lambda: made.append(1) or "VIEW")
try:
    check("portal_db._conn returns the sandbox view", portal_db._conn() == "VIEW" and made == [1])
finally:
    portal_db.SANDBOX_CONN.reset(tok)
check("SANDBOX_CONN default None", portal_db.SANDBOX_CONN.get() is None)

# ---------------------------------------------------------------------------
print("== savepoint proxy ==")
conn = FakeConn()
run = sb._Run(conn, False)
view = sb._SandboxConn(run)
view.commit()
view.rollback()
view.autocommit = True
check("autocommit stays off", view.autocommit is False)
view.close()
view.close()
check("commit = release + new savepoint; rollback = back to it; close = release",
      conn.log == ["SAVEPOINT of_sbx_1", "RELEASE SAVEPOINT of_sbx_1", "SAVEPOINT of_sbx_2",
                   "ROLLBACK TO SAVEPOINT of_sbx_2", "RELEASE SAVEPOINT of_sbx_2"], conn.log)
conn = FakeConn()
run = sb._Run(conn, False)
with sb._SandboxConn(run):
    inner = sb._SandboxConn(run)
    inner.close()
check("nested views + with-block", conn.log[:4] == ["SAVEPOINT of_sbx_1", "SAVEPOINT of_sbx_2",
                                                    "RELEASE SAVEPOINT of_sbx_2",
                                                    "RELEASE SAVEPOINT of_sbx_1"], conn.log)
conn = FakeConn()
run = sb._Run(conn, False)
view = sb._SandboxConn(run)
conn.fail_on = ("RELEASE",)
view.close()
check("aborted view: rolled back to its savepoint, then released",
      conn.log == ["SAVEPOINT of_sbx_1", "RELEASE SAVEPOINT of_sbx_1",
                   "ROLLBACK TO SAVEPOINT of_sbx_1", "RELEASE SAVEPOINT of_sbx_1"], conn.log)

# ---------------------------------------------------------------------------
print("== outside-call guard ==")
calls = []
real_open = sb._guarded_open.real
sb._guarded_open.real = lambda self, url, *a, **k: calls.append(
    url.full_url if isinstance(url, urllib.request.Request) else url) or "RESPONSE"


def from_module(module, code):
    scope = {"__name__": module, "urllib": urllib}
    exec(code, scope)
    return scope["result"]


try:
    check("guard installed on OpenerDirector.open",
          getattr(urllib.request.OpenerDirector.open, "_of_sandbox", False))
    check("inactive outside a run",
          from_module("portal_webhooks", "result = urllib.request.urlopen('https://hooks.x/y')") == "RESPONSE")
    run = sb._Run(None, False)
    token = sb._STATE.set(run)
    try:
        check("model call from portal_llm allowed",
              from_module("portal_llm", "result = urllib.request.urlopen("
                          "urllib.request.Request('https://api.x/v1/chat/completions', data=b'{}'))")
              == "RESPONSE")
        for module, url in (("portal_webhooks", "https://hooks.x/order"),
                            ("portal_couriers", "https://api.x/v1/chat/completions"),
                            ("portal_llm", "https://api.x/v1/other")):
            try:
                from_module(module, "result = urllib.request.urlopen('" + url + "')")
                blocked = False
            except urllib.error.URLError:
                blocked = True
            check("blocked: " + module + " " + url, blocked)
        try:
            from_module("portal_media_ai", "result = urllib.request.build_opener().open('https://cdn.x/a.jpg')")
            blocked = False
        except urllib.error.URLError:
            blocked = True
        check("build_opener path blocked too", blocked)
        import smtplib
        try:
            smtplib.SMTP("smtp.x", 25)
            blocked = False
        except smtplib.SMTPException:
            blocked = True
        check("smtp blocked", blocked)
        check("blocked calls recorded", [b["kind"] for b in run.blocked] == ["http"] * 4 + ["email"]
              and run.blocked[0]["by"] == "portal_webhooks", run.blocked)
    finally:
        sb._STATE.reset(token)
    check("only the model call went out", calls == ["https://hooks.x/y", "https://api.x/v1/chat/completions"],
          calls)
    import smtplib
    check("smtp untouched outside a run (no connect on bare init)", smtplib.SMTP() is not None)
finally:
    sb._guarded_open.real = real_open

# ---------------------------------------------------------------------------
print("== DDL flags ==")
import types  # noqa: E402
fake = types.ModuleType("portal_fake_flags")
fake._DDL_READY = False
fake._other_ensured = True
fake._COUNT_READY = 3
sys.modules["portal_fake_flags"] = fake
snap = sb._snapshot_flags()
fake._DDL_READY, fake._other_ensured, fake._COUNT_READY = True, False, 9
sb._restore_flags(snap)
check("bool flags restored", fake._DDL_READY is False and fake._other_ensured is True)
check("non-bool globals left alone", fake._COUNT_READY == 9)
del sys.modules["portal_fake_flags"]

# ---------------------------------------------------------------------------
print("== result shaping + expectations ==")
run = sb._Run(None, True)
run.usage = [{"prompt_tokens": 10, "completion_tokens": 2, "ok": True},
             {"prompt_tokens": 5, "completion_tokens": 0, "ok": False}]
run.blocked = [{"kind": "http", "target": "hooks.x", "by": "portal_webhooks"}]
raw = {
    "commands": [
        {"action": "send_message", "channel": "whatsapp",
         "payload": json.dumps({"external_user_id": "0000123@c.us", "body": "Ji haan", "source": "ai_brain"})},
        {"action": "send_message", "channel": "whatsapp",
         "payload": {"external_user_id": "923000000000@c.us", "body": "New lead", "source": "notify"}},
        {"action": "sync_contacts", "channel": "whatsapp", "payload": {}},
    ],
    "brain": [{"decision": "handoff", "grounding": {"reason": "policy:refund", "confidence": 0.4,
                                                     "tools": ["kb"], "citations": [1]}}],
    "claim": [{"claimed_by": "brain"}],
    "workflow_runs": [{"id": 7, "workflow_id": 3, "name": "W", "status": "waiting"}],
    "workflow_steps": [{"run_id": 7, "step_no": 0, "kind": "trigger", "outcome": "fired", "detail": ""},
                       {"run_id": 9, "step_no": 1, "kind": "x", "outcome": "y", "detail": ""}],
    "conversation": [{"status": "open", "assigned_user_id": 4, "secret": "no"}],
    "tags": [{"tag": "cod"}],
}
out = sb.summarize(raw, run, "0000123@c.us", {"channel": "whatsapp", "message": "m", "force_auto": True},
                   {"autonomy": "off", "effective": "off"}, "", 42)
check("reply to the test customer", out["outcome"]["replies"] == [
    {"body": "Ji haan", "source": "ai_brain", "channel": "whatsapp"}], out["outcome"])
check("team message + other command kept apart", len(out["other_messages"]) == 2
      and out["other_messages"][0].get("to") == "team", out["other_messages"])
check("claim decides the handler", out["outcome"]["handler"] == "brain"
      and out["outcome"]["handler_label"] == "AI brain")
check("policy reason explained", "refund" in out["ai"]["reason_text"], out["ai"])
check("off note", any("switched off" in n for n in out["outcome"]["notes"]), out["outcome"]["notes"])
check("off + Pretend Auto: no misleading 'turn it on' note",
      not any("Pretend AI is on Auto" in n for n in out["outcome"]["notes"]), out["outcome"]["notes"])
capped = sb.summarize({}, sb._Run(None, True), "c", {"channel": "whatsapp", "message": "m", "force_auto": True},
                      {"autonomy": "suggest", "effective": "suggest", "autonomy_cap": "suggest"}, "", 1)
check("platform cap explained", any("caps AI autonomy" in n for n in capped["outcome"]["notes"])
      and len(capped["outcome"]["notes"]) == 1, capped["outcome"]["notes"])
killed = sb.summarize({}, sb._Run(None, True), "c", {"channel": "whatsapp", "message": "m", "force_auto": True},
                      {"autonomy": "suggest", "effective": "off", "kill_switch": True,
                       "autonomy_cap": "suggest"}, "", 1)
check("kill switch: one clear note", killed["outcome"]["notes"] == [
    "AI is paused for the whole platform (admin kill switch)."], killed["outcome"]["notes"])
check("blocked note", any("blocked" in n for n in out["outcome"]["notes"]))
check("usage totals", out["usage"] == {"calls": 2, "tokens": 17, "failed": 1}, out["usage"])
check("workflow steps grouped per run", out["workflows"][0]["steps"] == [
    {"step_no": 0, "kind": "trigger", "outcome": "fired", "detail": ""}], out["workflows"])
check("routing only whitelisted keys", out["routing"] == {"status": "open", "assigned_user_id": 4},
      out["routing"])
check("tags + saved flag", out["tags"] == ["cod"] and out["saved"] is False and out["ok"] is True)
out = sb.summarize({"escalations": [{"reason": "needs_human"}]}, sb._Run(None, False), "c",
                   {"channel": "whatsapp", "message": "m"}, {"autonomy": "suggest", "effective": "suggest"},
                   "boom", 1)
check("handoff without reply -> handoff; error -> not ok",
      out["outcome"]["handler"] == "handoff" and out["ok"] is False)
check("suggest note offers Pretend Auto", any("Pretend AI is on Auto" in n for n in out["outcome"]["notes"]))
res = {"outcome": {"handler": "kb", "replies": [{"body": "Delivery 3-5 din"}]}, "handoffs": []}
check("expect handler", sb.evaluate(res, "kb", "", "")["pass"] is True
      and sb.evaluate(res, "brain", "", "")["pass"] is False)
check("expect words (case-insensitive)", sb.evaluate(res, "any_reply", "DELIVERY", "refund")["pass"] is True
      and sb.evaluate(res, "", "", "din")["pass"] is False)
check("no_reply / handoff", sb.evaluate(res, "no_reply", "", "")["pass"] is False
      and sb.evaluate({"outcome": {}, "handoffs": [{}]}, "handoff", "", "")["pass"] is True)
check("errors fail", sb.evaluate({"outcome": {}, "error": "x"}, "", "", "")["pass"] is False)
check("expect list matches labels", all(h in sb.HANDLER_LABELS for h in sb.EXPECT_HANDLERS
                                        if h not in ("", "any_reply", "no_reply")))

# ---------------------------------------------------------------------------
print("== source pins ==")
db_src = src(os.path.join(CP, "portal_db.py"))
check("portal_db: factory first in _conn",
      "SANDBOX_CONN.get()" in db_src.split("def _conn():", 1)[1].split("import psycopg2", 1)[0])
for name, needle in (("portal_ratelimit.py", "sandbox.active()"),
                     ("portal_ai_usage.py", "sandbox.capture_usage("),
                     ("portal_brain.py", "sandbox.autonomy_override(own)")):
    text = src(os.path.join(CP, name))
    check(name + ": hook via sys.modules (no import cycle)",
          needle in text and 'sys.modules.get("portal_sandbox")' in text
          and "import portal_sandbox" not in text)
app_src = src(os.path.join(CP, "app.py"))
check("app registers the sandbox blueprint",
      "from portal_sandbox import bp as portal_sandbox_bp" in app_src
      and "aux_app.register_blueprint(portal_sandbox_bp)" in app_src)
check("connector_api untouched by 230", "portal_sandbox" not in src(os.path.join(CP, "connector_api.py")))
check("blueprint prefix", sb.bp.url_prefix == "/api/v1/portal/sandbox")

sys.modules.pop("portal_kb", None)
import portal_kb  # noqa: E402
check("portal_kb brand flag defined (was a NameError)", portal_kb._BRAND_DDL_READY is False)


class _KbConn:
    def __init__(self):
        self.sql = []

    def cursor(self):
        return FakeCur(self.sql)

    def commit(self):
        pass

    def rollback(self):
        pass


kb_conn = _KbConn()
portal_kb._ensure_brand_column(kb_conn)
check("brand column ensure runs", portal_kb._BRAND_DDL_READY is True
      and any("brand_id" in s for s in kb_conn.sql), kb_conn.sql)


# ---------------------------------------------------------------------------
def web():
    print("== web ==")
    page = os.path.join(ROOT, "app/dashboard/(portal)/sandbox")
    client = src(os.path.join(page, "SandboxClient.tsx"))
    check("page exists", os.path.exists(os.path.join(page, "page.tsx")))
    for needle in ("Nothing is sent or saved.", "Pretend AI is on Auto", "What happened", "Saved tests",
                   "Run all", '"/api/omniflow/portal/sandbox"', "count toward your AI usage"):
        check("client: " + needle, needle in client)
    forbidden = {0x25B6, 0x261D, 0x2714, 0x26A1, 0x2699, 0x2709, 0x260E, 0x2733, 0x263A, 0x25FC, 0x27A1,
                 0x274C, 0x2716}
    check("client: no emoji-capable glyphs",
          not [c for c in client if ord(c) in forbidden or ord(c) >= 0x1F000])
    api = os.path.join(ROOT, "app/api/omniflow/portal/sandbox")
    for rel, needles in (("route.ts", ["getSandbox", "export async function GET"]),
                         ("run/route.ts", ["export const maxDuration = 60", "runSandbox", "}, request);"]),
                         ("scenarios/route.ts", ["createSandboxScenario", "}, request);"]),
                         ("scenarios/[id]/route.ts", ["updateSandboxScenario", "deleteSandboxScenario",
                                                      "export async function PUT",
                                                      "export async function DELETE"]),
                         ("scenarios/[id]/run/route.ts", ["export const maxDuration = 60",
                                                          "runSandboxScenario", "request);"])):
        text = src(os.path.join(api, rel))
        check("bff " + rel, all(n in text for n in needles), rel)
    portal = src(os.path.join(ROOT, "lib/omniflow/portal.ts"))
    check("portal.ts service", all(n in portal for n in (
        'const SANDBOX = "api/v1/portal/sandbox"', "SANDBOX_TIMEOUT_MS = 55_000",
        "export function runSandbox(", "export function runSandboxScenario(",
        '"sandbox_unavailable"', 'code === keepCode')))
    shaper = src(os.path.join(ROOT, "lib/omniflow/sandbox-input.ts"))
    check("bff channels = CP channels",
          all('"' + c + '"' in shaper.split("const HANDLERS")[0] for c in sb.CHANNELS))
    check("bff expectations = CP expectations",
          all('"' + h + '"' in shaper.split("const HANDLERS")[1] for h in sb.EXPECT_HANDLERS))
    side = src(os.path.join(ROOT, "app/dashboard/components/DashSidebar.tsx"))
    side += "\n" + src(os.path.join(ROOT, "app/dashboard/components/portalNav.ts"))  # §246 nav entries live in portalNav.ts
    check("sidebar entry after Configure AI", side.index('"AI Sandbox", href: "/dashboard/sandbox", icon: "sandbox"')
          > side.index('"Configure AI"'))
    check("palette entry", "NAV_GROUPS.flatMap(" in src(
        os.path.join(ROOT, "app/dashboard/components/CommandPalette.tsx")))


# ---------------------------------------------------------------------------
def db_half():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    import tempfile
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="sbx230_")
    server = pgserver.get_server(data, cleanup_mode="stop")
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()

    def sql(q, a=(), fetch=True):
        c = psycopg2.connect(host=data, dbname="postgres", user="postgres")
        try:
            cur = c.cursor()
            cur.execute(q, a)
            got = cur.fetchall() if fetch and cur.description else None
            c.commit()
            return got
        finally:
            c.close()

    # what a live database already has: main-bot / migration tables + every lazy table
    for q in (
        "CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ DEFAULT NOW())",
        "CREATE TABLE IF NOT EXISTS client_settings (client_id BIGINT PRIMARY KEY,"
        " settings JSONB NOT NULL DEFAULT '{}'::jsonb)",
        "CREATE TABLE IF NOT EXISTS portal_kb_settings (client_id BIGINT PRIMARY KEY,"
        " auto_reply BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ DEFAULT NOW())",
        "CREATE TABLE IF NOT EXISTS portal_kb_entries (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL,"
        " title TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL"
        " DEFAULT '', content TEXT NOT NULL DEFAULT '', is_active BOOLEAN NOT NULL DEFAULT TRUE,"
        " usage_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(),"
        " updated_at TIMESTAMPTZ DEFAULT NOW())",
        "CREATE TABLE IF NOT EXISTS portal_saved_replies (id BIGSERIAL PRIMARY KEY, client_id BIGINT"
        " NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',"
        " created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())",
    ):
        sql(q, fetch=False)
    import glob
    import importlib
    import inspect
    for _ in range(2):
        for path in sorted(glob.glob(CP + "/portal_*.py")):
            name = os.path.basename(path)[:-3]
            if name == "portal_sandbox":
                continue
            try:
                mod = importlib.import_module(name)
            except Exception:
                continue
            for attr, fn in list(vars(mod).items()):
                if not attr.startswith("_ensure") or not inspect.isfunction(fn) \
                        or getattr(fn, "__module__", "") != name:
                    continue
                try:
                    if len(inspect.signature(fn).parameters) != 1:
                        continue
                except (TypeError, ValueError):
                    continue
                c = psycopg2.connect(host=data, dbname="postgres", user="postgres")
                try:
                    try:
                        fn(c)
                    except Exception:
                        c.rollback()
                        with c.cursor() as cur:
                            fn(cur)
                    c.commit()
                except Exception:
                    c.rollback()
                finally:
                    c.close()

    cid = 7
    tables = ["portal_conversations", "portal_messages", "portal_connector_commands", "portal_action_log",
              "portal_brain_traces", "portal_escalations", "portal_workflow_runs", "portal_intelligence"]

    def counts():
        got = {}
        for t in tables:
            try:
                got[t] = sql("SELECT COUNT(*) FROM " + t)[0][0]
            except Exception:
                got[t] = None
        return got

    def autonomy(level):
        sql("INSERT INTO portal_brain_settings (client_id, autonomy) VALUES (%s, %s)"
            " ON CONFLICT (client_id) DO UPDATE SET autonomy = EXCLUDED.autonomy", (cid, level), fetch=False)

    def clean(**kw):
        body = {"message": "COD hai kya?", "channel": "whatsapp"}
        body.update(kw)
        got, why = sb.clean_input(body)
        assert got is not None, why
        return got

    def brain_calls():
        return [b for p, b in SEEN if p.endswith("/chat/completions") and "needs_human" in json.dumps(b)]

    autonomy("suggest")
    before = counts()
    SEEN.clear()
    r = sb.run_message(cid, clean())
    check("db: suggest -> no reply, brain not called", r["outcome"]["replies"] == [] and not brain_calls(),
          (r["outcome"], SEEN))
    check("db: nothing persisted (suggest)", counts() == before, (before, counts()))

    SEEN.clear()
    r = sb.run_message(cid, clean(force_auto=True, history=[
        {"role": "customer", "text": "Salam, order karna hai"},
        {"role": "business", "text": "Walaikum salam, zaroor!"}]))
    check("db: Pretend Auto -> the real brain reply", [x["body"] for x in r["outcome"]["replies"]]
          == [REPLY["reply"]] and r["outcome"]["handler"] == "brain", r["outcome"])
    check("db: AI decision + intelligence collected", (r["ai"] or {}).get("decision") == "send"
          and (r["intelligence"] or {}).get("intent"), (r["ai"], r["intelligence"]))
    check("db: earlier turns reached the model", brain_calls()
          and "order karna hai" in json.dumps(brain_calls()[-1]))
    n_llm = len([p for p, _ in SEEN if p.endswith("/chat/completions")])
    check("db: usage counted", r["usage"]["calls"] == n_llm and r["usage"]["tokens"] == 49 * n_llm, r["usage"])
    check("db: nothing persisted (auto)", counts() == before, (before, counts()))
    led = sql("SELECT client_id, feature, route FROM portal_ai_usage ORDER BY id DESC LIMIT %s", (n_llm,))
    check("db: real AI cost written after the rollback (route sandbox)",
          len(led) == n_llm and all(x[0] == cid and x[2] == "sandbox" for x in led)
          and any(x[1] == "brain" for x in led), led)

    autonomy("off")
    SEEN.clear()
    r = sb.run_message(cid, clean(force_auto=True))
    check("db: off is never lifted", r["outcome"]["replies"] == [] and not brain_calls()
          and any("switched off" in n for n in r["outcome"]["notes"]), r["outcome"])
    autonomy("suggest")

    import portal_cod
    import smtplib
    hits = {}
    real_cod = portal_cod.maybe_cod_flow

    def outside(*a, **k):
        for key, fn in (("http", lambda: urllib.request.urlopen(MODEL_URL + "/hooks/order", data=b"{}",
                                                                  timeout=2)),
                        ("opener", lambda: urllib.request.build_opener().open(MODEL_URL + "/hooks/o",
                                                                                timeout=2)),
                        ("smtp", lambda: smtplib.SMTP("127.0.0.1", 2525, timeout=1))):
            try:
                fn()
                hits[key] = "sent"
            except Exception as error:
                hits[key] = type(error).__name__
        return False

    portal_cod.maybe_cod_flow = outside
    SEEN.clear()
    try:
        r = sb.run_message(cid, clean(force_auto=True))
    finally:
        portal_cod.maybe_cod_flow = real_cod
    check("db: webhook / opener / smtp blocked inside the real ingest",
          all(hits.get(k) not in (None, "sent") for k in ("http", "opener", "smtp"))
          and not [p for p, _ in SEEN if "hooks" in p] and len(r["blocked"]) == 3, (hits, r["blocked"]))
    check("db: the model call still went out", len(brain_calls()) == 1)

    def committer(client_id, conversation_id, frm, name, body, direction, conn):
        with conn.cursor() as cur:
            cur.execute("INSERT INTO portal_action_log (client_id, action) VALUES (%s, 'hook.commit')",
                        (client_id,))
        conn.commit()
        other = portal_db._conn()
        with other.cursor() as cur:
            cur.execute("INSERT INTO portal_action_log (client_id, action) VALUES (%s, 'hook.other')",
                        (client_id,))
        other.commit()
        other.close()
        return False

    portal_cod.maybe_cod_flow = committer
    try:
        r = sb.run_message(cid, clean(force_auto=True))
    finally:
        portal_cod.maybe_cod_flow = real_cod
    acts = [t["action"] for t in r["timeline"]]
    check("db: hook commits visible inside the run", "hook.commit" in acts and "hook.other" in acts, acts)
    check("db: hook commits rolled back",
          sql("SELECT COUNT(*) FROM portal_action_log WHERE action LIKE 'hook.%%'")[0][0] == 0)
    check("db: reply still produced after hook commits", bool(r["outcome"]["replies"]))

    c = portal_db._conn()
    with c.cursor() as cur:
        sb._arm_commit_guard(cur)
        cur.execute("INSERT INTO portal_action_log (client_id, action) VALUES (%s, 'leak')", (cid,))
    try:
        c.commit()
        committed = True
    except Exception:
        committed = False
    c.close()
    check("db: an armed transaction can never COMMIT", committed is False
          and sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'leak'")[0][0] == 0)

    lock = psycopg2.connect(host=data, dbname="postgres", user="postgres")
    lock.cursor().execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("of_sandbox:" + str(cid),))
    try:
        sb.run_message(cid, clean())
        busy = False
    except sb.SandboxBusy:
        busy = True
    lock.rollback()
    lock.close()
    check("db: one run at a time per workspace", busy)

    portal_brain._DDL_READY = False
    sql("DROP TABLE IF EXISTS portal_brain_traces CASCADE", fetch=False)
    r = sb.run_message(cid, clean(force_auto=True))
    check("db: the run created the table it needed (inside the transaction)", r["ai"] is not None, r["ai"])
    check("db: lazy-DDL flag restored, so the table is created for real later",
          portal_brain._DDL_READY is False
          and not sql("SELECT to_regclass('portal_brain_traces')")[0][0])
    c = portal_db._conn()
    with c.cursor() as cur:
        portal_brain._ensure_ddl(cur)
    c.commit()
    c.close()
    check("db: next real call recreates it", portal_brain._DDL_READY is True
          and sql("SELECT to_regclass('portal_brain_traces')")[0][0])

    tried = {}

    def raw_committer(client_id, conversation_id, frm, name, body, direction, conn):
        with conn.cursor() as cur:
            cur.execute("INSERT INTO portal_action_log (client_id, action) VALUES (%s, 'raw.commit')",
                        (client_id,))
        try:
            sb._STATE.get().conn.commit()  # the real connection, past the proxy
            tried["commit"] = "committed"
        except Exception as error:
            tried["commit"] = type(error).__name__
        return False

    portal_cod.maybe_cod_flow = raw_committer
    try:
        r = sb.run_message(cid, clean(force_auto=True))
    finally:
        portal_cod.maybe_cod_flow = real_cod
    check("db: a raw COMMIT inside a run is refused", tried.get("commit") not in (None, "committed"), tried)
    check("db: ... and nothing from that run persisted", counts() == before
          and sql("SELECT COUNT(*) FROM portal_action_log WHERE action = 'raw.commit'")[0][0] == 0,
          (before, counts()))
    check("db: the run reports a problem instead of a fake success", r["ok"] is False or r["error"], r["error"])

    wf = sql("INSERT INTO portal_workflows (client_id, name, status, trigger_type, trigger_config)"
             " VALUES (%s, 'COD helper', 'active', 'message_received', '{\"keyword\": \"cod\"}')"
             " RETURNING id", (cid,))[0][0]
    sql("INSERT INTO portal_workflow_steps (client_id, workflow_id, step_no, kind, label, config) VALUES"
        " (%s, %s, 1, 'handoff', 'Ask a person', '{\"note\": \"COD question\"}'),"
        " (%s, %s, 2, 'stop', 'Done', '{}')", (cid, wf, cid, wf), fetch=False)
    r = sb.run_message(cid, clean())
    steps = (r["workflows"] or [{}])[0].get("steps") or []
    check("db: workflow fired and its steps simulated",
          r["workflows"] and r["workflows"][0]["name"] == "COD helper"
          and [s["kind"] for s in steps] == ["trigger", "handoff", "stop"], r["workflows"])
    r = sb.run_message(cid, clean(simulate_workflows=False))
    check("db: workflow steps optional", [s["kind"] for s in (r["workflows"] or [{}])[0].get("steps") or []]
          == ["trigger"], r["workflows"])
    sql("DELETE FROM portal_workflow_steps", fetch=False)
    sql("DELETE FROM portal_workflows", fetch=False)

    from flask import Flask
    app = Flask("sandbox230")
    app.register_blueprint(sb.bp)
    who = {"role": "owner"}
    real_auth = sb.authenticate_portal_request
    sb.authenticate_portal_request = lambda: dict(client_id=cid, user_id=5, email="o@x.pk", **who)
    try:
        cl = app.test_client()
        ov = cl.get("/api/v1/portal/sandbox")
        check("api: overview", ov.status_code == 200 and (ov.get_json() or {}).get("limits", {})
              .get("runs_per_hour") == 60, ov.get_data(as_text=True)[:200])
        who["role"] = "agent"
        check("api: agents may not run it", cl.post("/api/v1/portal/sandbox/run",
                                                    json={"message": "x"}).status_code == 403)
        who["role"] = "admin"
        check("api: validation 400", cl.post("/api/v1/portal/sandbox/run",
                                             json={"message": "", "channel": "whatsapp"}).status_code == 400)
        ran = cl.post("/api/v1/portal/sandbox/run", json={"message": "COD hai kya?", "force_auto": True})
        check("api: run", ran.status_code == 200 and (ran.get_json() or {}).get("outcome", {}).get("replies"))
        made = cl.post("/api/v1/portal/sandbox/scenarios", json={
            "name": "COD answer", "message": "COD hai kya?", "force_auto": True,
            "expect_handler": "brain", "expect_contains": "COD", "expect_absent": "refund"})
        sid = ((made.get_json() or {}).get("scenario") or {}).get("id")
        check("api: saved test created", made.status_code == 201 and sid, made.get_data(as_text=True)[:200])
        rv = cl.post("/api/v1/portal/sandbox/scenarios/%s/run" % sid).get_json() or {}
        row = sql("SELECT last_pass, last_result FROM portal_sandbox_scenarios WHERE id = %s", (sid,))
        check("api: saved test passes and the verdict is stored",
              rv.get("verdict", {}).get("pass") is True and row[0][0] is True
              and row[0][1].get("handler") == "brain", (rv.get("verdict"), row))
        up = cl.put("/api/v1/portal/sandbox/scenarios/%s" % sid, json={
            "name": "COD answer", "message": "COD hai kya?", "force_auto": True,
            "expect_handler": "brain", "expect_absent": "COD"})
        rv = cl.post("/api/v1/portal/sandbox/scenarios/%s/run" % sid).get_json() or {}
        check("api: edited test now fails", up.status_code == 200 and rv.get("verdict", {}).get("pass") is False)
        sb.authenticate_portal_request = lambda: dict(user_id=6, email="b@x.pk", role="owner", client_id=cid + 1)
        check("api: another workspace cannot see it",
              cl.post("/api/v1/portal/sandbox/scenarios/%s/run" % sid).status_code == 404
              and cl.delete("/api/v1/portal/sandbox/scenarios/%s" % sid).status_code == 404)
        sb.authenticate_portal_request = lambda: dict(client_id=cid, user_id=5, email="o@x.pk", role="owner")
        check("api: delete", cl.delete("/api/v1/portal/sandbox/scenarios/%s" % sid).status_code == 200)
    finally:
        sb.authenticate_portal_request = real_auth
    check("db: nothing persisted (final)", counts() == before, (before, counts()))
    server.cleanup()


web()
db_half()
MODEL.shutdown()
sys.exit(1 if summary("sandbox") else 0)
