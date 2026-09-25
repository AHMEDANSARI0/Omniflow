"""Shared stubs for Control Plane endpoint tests (no real DB, no Flask server).

DbStub: script one entry per cur.execute() call, in order.
  entry = list of row-dicts -> description built from first row's keys
  entry = []                -> description None, zero rows
  entry = Exception         -> raised from execute()

PrincipalStub: replaces authenticate_portal_request on a module.
"""

import os


class FakeCur:
    def __init__(self, script):
        self._script = list(script)
        self.executed = []
        self.description = None
        self._rows = []
        self.rowcount = 0

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if not self._script:
            raise AssertionError(
                "DbStub exhausted at execute #%d" % len(self.executed)
            )
        entry = self._script.pop(0)
        if isinstance(entry, Exception):
            raise entry
        if isinstance(entry, int):
            self.rowcount = entry
            self.description = None
            self._rows = []
            return
        if entry:
            keys = list(entry[0].keys())
            self.description = tuple((k,) for k in keys)
            self._rows = [tuple(r[k] for k in keys) for r in entry]
        else:
            self.description = None
            self._rows = []

    def fetchall(self):
        return list(self._rows)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeConn:
    def __init__(self, script):
        self.cur = FakeCur(script)
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class _DbStub:
    CONV_TABLE = "portal_conversations"
    MSGS_TABLE = "portal_messages"
    CSAT_TABLE = "portal_csat_requests"
    TEAM_TABLE = "portal_team_members"
    BROADCASTS_TABLE = "portal_broadcasts"
    BOT_TABLE = "portal_bot_configs"
    SAVED_REPLIES_TABLE = "portal_saved_replies"
    CONV_TAGS_TABLE = "portal_conversation_tags"
    STATUS_TABLE = "portal_whatsapp_status"
    CMD_TABLE = "portal_connector_commands"
    PROFILE_TABLE = "portal_profiles"
    APIKEY_TABLE = "portal_api_keys"
    USERS_TABLE = "platform_users"
    NOTES_TABLE = "portal_conversation_notes"
    GAPS_TABLE = "portal_kb_gaps"

    def __init__(self, client_id=1):
        self.client_id = client_id
        self.conn = None

    def _q(self, ident):
        return ident

    def ensure_tables(self):
        pass

    def _conn(self):
        return self.conn

    def rows(self, cur):
        if cur.description is None:
            return []
        keys = [d[0] for d in cur.description]
        return [dict(zip(keys, row)) for row in cur.fetchall()]

    def log_action(self, cur, client_id, action, actor_kind="customer_user",
                   actor_user_id=None, conversation_id=None, note=""):
        cur.execute(
            "INSERT INTO portal_action_log"
            " (client_id, action, actor_kind, actor_user_id, conversation_id,"
            " note, created_at) VALUES (%s, %s, %s, %s, %s, %s, NOW())",
            (client_id, action, actor_kind, actor_user_id, conversation_id, note),
        )

    def portal_unavailable(self, error, context):
        return ({"error": {"code": "db_unavailable",
                           "message": context + " temporarily unavailable."}},)


def install_db_stub(module, script, client_id=1):
    """Replace module.portal_db with a scripted stub.

    Returns the FakeConn (inspect .cur.executed after the request).
    """
    stub = _DbStub(client_id=client_id)
    stub.conn = FakeConn(script)
    module.portal_db = stub
    return stub.conn


class PrincipalStub:
    """Install authenticate_portal_request on `module`.

    principal=None            -> route should 401
    exc=Exception instance    -> route should map it (e.g. 503)
    otherwise                 -> that principal dict is returned
    """

    def __init__(self, module, principal=None, exc=None):
        self.module = module
        self.principal = principal
        self.exc = exc
        self._original = getattr(module, "authenticate_portal_request", None)
        module.authenticate_portal_request = self._fake

    def _fake(self):
        if self.exc is not None:
            raise self.exc
        return self.principal

    def restore(self):
        if self._original is not None:
            self.module.authenticate_portal_request = self._original


def human_principal(client_id=1, user_id=11, email="ahmed@example.com"):
    return {
        "session_id": "sess-test",
        "user_id": user_id,
        "client_id": client_id,
        "role": "owner",
        "email": email,
        "display_name": "Ahmed",
        "via_api_key": False,
    }


def body(response):
    """JSON body of a Flask test response."""
    return response.get_json()


def status(response):
    return response.status_code


_checks = {"pass": 0, "fail": 0, "details": []}


def check(name, condition, detail=""):
    if condition:
        _checks["pass"] += 1
        print("  PASS  " + name)
    else:
        _checks["fail"] += 1
        _checks["details"].append((name, detail))
        print("  FAIL  " + name + "  ::  " + str(detail)[:200])


def summary(label):
    print("")
    print("SUMMARY[" + label + "]: " + str(_checks["pass"]) +
          " PASS, " + str(_checks["fail"]) + " FAIL")
    for name, detail in _checks["details"]:
        print("  - " + name + " :: " + str(detail)[:160])
    failures = _checks["fail"]
    _checks["pass"] = 0
    _checks["fail"] = 0
    _checks["details"] = []
    return failures


def portal_page_source(route: str, clients=None) -> str:
    """Source of a portal page split into server wrapper + client component."""
    if clients is None:
        clients = ("InboxClient.tsx", "CustomersClient.tsx")
    base = "/tmp/p13/Omniflow/app/dashboard/(portal)/" + route + "/"
    src = open(base + "page.tsx").read()
    for name in clients:
        path = base + name
        if os.path.exists(path):
            src += "\n" + open(path).read()
    return src


def portal_thread_source() -> str:
    """Combined thread page + client component source."""
    return portal_page_source("conversations/[id]", ("ThreadClient.tsx",))
