"""Boot + dispatch test for the Control Plane entry point (app.py).

Imports the REAL app.py with the primary API stubbed (the control_plane
package lives in the CP repo's src/, not in this tree) and proves:

* every module app.py imports actually imports together (one broken
  blueprint = the whole Vercel deployment answering 500 - this is the
  check that a 13-batch jump needs),
* every route the extension blueprints define is dispatched to aux_app by
  the composite WSGI (public checkout/store/voice webhooks and the admin
  providers / email / weekly report / AI control routes used to sit
  behind the primary API's 404 because the prefix tuple did not name
  them),
* the primary API keeps its own paths (health, login, refresh, me,
  logout, onboarding) and everything unknown,
* the dependency law: the CP tree needs nothing beyond flask, werkzeug
  and psycopg2 (requirements.txt unchanged).
"""
import ast
import os
import re
import sys
import types

from test_lib import check, summary

# ---------- stub the primary API before app.py imports it ----------
PRIMARY_BODY = b"primary-api"


def _primary(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [PRIMARY_BODY]


_pkg = types.ModuleType("control_plane")
_pkg.__path__ = []  # mark as package
_http = types.ModuleType("control_plane.http_api")
_http.create_control_plane_api = lambda *a, **k: _primary
sys.modules["control_plane"] = _pkg
sys.modules["control_plane.http_api"] = _http

print("== boot ==")
import_error = None
try:
    import app  # noqa: E402  (the real entry point)
except Exception as error:  # pragma: no cover - reported as a failure
    import_error = error
    app = None
check("app.py imports with every blueprint", import_error is None, repr(import_error))
if app is None:
    summary("app_boot")
    sys.exit(1)

CP = os.path.dirname(os.path.abspath(app.__file__))  # the real CP tree
check("aux_app carries the extension blueprints (>= 70)",
      len(app.aux_app.blueprints) >= 70, len(app.aux_app.blueprints))
check("application is the composite dispatcher",
      isinstance(app.application, app._CompositeWsgi), type(app.application))
check("Vercel entry `app` is the composite", app.app is app.application, "alias")
check("prefix tuple kept (fast path)",
      "/api/v1/portal/" in app._EXTENSION_PREFIXES
      and "/api/v1/connector/" in app._EXTENSION_PREFIXES, app._EXTENSION_PREFIXES)

# ---------- every aux route is reachable through the composite ----------
print("== dispatch ==")
from werkzeug.test import EnvironBuilder  # noqa: E402

SAMPLES = {"int": "1", "float": "1.5", "path": "a/b", "uuid": "00000000-0000-0000-0000-000000000000"}


def concrete(rule_text):
    def sub(match):
        converter = match.group(1) or "string"
        return SAMPLES.get(converter, "sample")
    return re.sub(r"<(?:(\w+)(?:\([^)]*\))?:)?(\w+)>", sub, rule_text)


def dispatch(path, method="GET", headers=None):
    env = EnvironBuilder(path=path, method=method, headers=headers or {}).get_environ()
    captured = {}

    def start_response(status, response_headers, exc_info=None):
        captured["status"] = status

    body = b"".join(app.application(env, start_response))
    return captured.get("status", ""), body


rules = [r for r in app.aux_app.url_map.iter_rules() if r.endpoint != "static"]
check("aux routes enumerated (>= 300)", len(rules) >= 300, len(rules))
unreachable = []
for rule in rules:
    methods = sorted((rule.methods or {"GET"}) - {"HEAD", "OPTIONS"}) or ["GET"]
    path = concrete(rule.rule)
    if not app._aux_serves(path, methods[0]):
        unreachable.append(methods[0] + " " + rule.rule)
check("every aux route is dispatched to aux_app (none behind the primary 404)",
      not unreachable, unreachable[:12])

outside_prefix = [r for r in rules if not concrete(r.rule).startswith(app._EXTENSION_PREFIXES)]
check("routes outside the prefix tuple exist and are covered by the URL-map net",
      len(outside_prefix) >= 10
      and all(app._aux_serves(concrete(r.rule), "GET") for r in outside_prefix),
      len(outside_prefix))
for expected in ("/api/v1/public/checkout/<token>", "/api/v1/public/store/<slug>",
                 "/api/v1/public/voice/incoming", "/api/v1/admin/providers",
                 "/api/v1/admin/ai/overview",
                 "/api/v1/admin/ai/clients/<int:client_id>/autonomy"):
    check("route registered: " + expected,
          any(r.rule == expected for r in rules), expected)

# real requests through the composite: aux answers (auth / storage errors),
# never the primary stub body
status, body = dispatch("/api/v1/public/checkout/nope")
check("public checkout reaches aux (not primary)", body != PRIMARY_BODY and status[:3] in ("404", "503"),
      (status, body[:50]))
status, body = dispatch("/api/v1/admin/providers")
check("admin providers reaches aux -> 403 without key", status.startswith("403"), (status, body[:50]))
status, body = dispatch("/api/v1/admin/ai/overview")
check("admin AI overview reaches aux -> 403 without key", status.startswith("403"), (status, body[:50]))
status, body = dispatch("/api/v1/admin/providers", "DELETE")
check("wrong method on an aux route stays with aux (405)", status.startswith("405"), status)
status, body = dispatch("/api/v1/portal/agents")
check("portal prefix -> aux 401 without session", status.startswith("401"), status)

# primary keeps its own paths + everything unknown
for path, method in (("/api/v1/health", "GET"), ("/api/v1/auth/login", "POST"),
                     ("/api/v1/auth/refresh", "POST"), ("/api/v1/auth/me", "GET"),
                     ("/api/v1/auth/logout", "POST"), ("/api/v1/admin/onboarding", "POST"),
                     ("/api/v1/nothing/here", "GET"), ("/", "GET")):
    status, body = dispatch(path, method)
    check("primary keeps " + method + " " + path, body == PRIMARY_BODY, (status, body[:30]))
check("_aux_serves never raises on junk", app._aux_serves("", "") is False
      and app._aux_serves("/api/v1/portal/", "WEIRD") is True, "junk")

# ---------- dependency law ----------
print("== dependencies ==")
std = set(getattr(sys, "stdlib_module_names", set()))
local = {f[:-3] for f in os.listdir(CP) if f.endswith(".py")}
third = set()
for name in sorted(os.listdir(CP)):
    if not name.endswith(".py"):
        continue
    tree = ast.parse(open(os.path.join(CP, name), encoding="utf8").read())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            third.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            third.add(node.module.split(".")[0])
third = {m for m in third if m not in std and m not in local}
check("CP imports nothing beyond flask / werkzeug / psycopg2 / control_plane"
      " / pypdf (lazy, PDF import only) / PIL (lazy, optional OCR fallback)",
      third <= {"flask", "werkzeug", "psycopg2", "control_plane", "pypdf", "PIL"},
      sorted(third))
pil_users = sorted(
    name for name in os.listdir(CP) if name.endswith(".py")
    and re.search(r"\bPIL\b", open(os.path.join(CP, name), encoding="utf8").read()))
kbf = open(os.path.join(CP, "portal_kb_files.py"), encoding="utf8").read()
check("PIL only in portal_kb_files, never at module level (CP boots without it)",
      pil_users == ["portal_kb_files.py"] and "\nimport PIL" not in kbf
      and "\nfrom PIL" not in kbf, pil_users)

src = open(os.path.join(CP, "app.py"), encoding="utf8").read()
check("app.py: URL-map safety net present",
      "_AUX_URLS = aux_app.url_map.bind(" in src and "def _aux_serves(" in src
      and "if _aux_serves(path, environ.get(\"REQUEST_METHOD\", \"GET\")):" in src, "pins")
check("app.py: werkzeug exceptions imported for the net",
      "from werkzeug.exceptions import MethodNotAllowed, NotFound" in src
      and "from werkzeug.routing import RequestRedirect" in src, "imports")

summary("app_boot")
