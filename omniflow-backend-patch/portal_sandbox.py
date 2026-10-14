"""§230 AI Sandbox - try a customer message against the REAL setup, safely.

The owner types a message as a test customer. The sandbox runs the one
production ingest path (connector_api.ingest_messages_for_tenant: one-reply
law, approvals, away reply, COD, AI brain, knowledge auto-reply, language,
compliance, listen, routing, intelligence, sequences, workflows) and then
the first steps of any workflow it started - exactly the code real
customers hit, no second engine. Everything happens inside ONE database
transaction that is always rolled back, so:

  * nothing is saved: no conversation, message, command, handoff, approval,
    workflow run, tag or audit row survives the run;
  * nothing is sent: replies are queued commands that are rolled back
    before the WhatsApp/Instagram bridge can see them, and while a run is
    active every outbound HTTP call or email (couriers, webhooks, Twilio,
    payments, notification email ...) is refused - only the AI engine
    (portal_llm) may be called, so the reply is the real model's answer.
    The guard sits on urllib's OpenerDirector.open (urlopen and
    build_opener both pass there - the control plane's only HTTP client)
    and on smtplib.SMTP / SMTP_SSL;
  * a COMMIT is impossible: a deferred constraint trigger on a temp table
    raises at commit time, so even a stray commit cannot persist anything.

How the isolation works (only inside the request that runs the sandbox):
  * portal_db._conn() returns a savepoint-scoped view of the sandbox
    transaction (portal_db.SANDBOX_CONN), so hooks that open their own
    connection and commit stay inside it;
  * portal_ratelimit.allow() is skipped (no real counters touched/locked);
  * portal_ai_usage.record() is buffered and written after the rollback
    with route "sandbox" - AI calls cost money and are always in the ledger;
  * lazy-DDL "ready" flags of every loaded module are snapshotted before
    the run and restored after it (a table created inside the rolled-back
    transaction must be created again for real later).

Before reading what happened the run is collected from the rolled-back
transaction: replies that would be sent, which automation claimed the
message, the AI decision (confidence, tools, knowledge citations, reason),
handoffs, approvals, workflow runs + steps, sequence enrollments, routing,
tags, intelligence, notifications, the audit timeline and the outside calls
that were blocked.

Saved tests: named scenarios (message + optional earlier turns + expected
outcome) that the owner re-runs after changing the AI setup.

Known edge: a knowledge auto-reply bumps that KB entry's usage_count, so
the row stays locked until the run ends (a real auto-reply using the same
entry waits up to a few seconds).

Rules: the platform kill switch / autonomy cap / budgets still apply.
"Pretend AI is on Auto" only lifts the workspace's own 'suggest' to 'auto'
(never 'off', never above the platform cap, never a draft-only persona).
Only OF_SANDBOX_ROLES may run it; OF_SANDBOX_RUNS_PER_HOUR per workspace;
one run at a time per workspace.

Env (optional): OF_SANDBOX_ROLES=owner,admin  OF_SANDBOX_RUNS_PER_HOUR=60
OF_SANDBOX_MAX_HISTORY=12  OF_SANDBOX_SCENARIOS_MAX=50
OF_SANDBOX_TX_SECONDS=90 (a stuck run's transaction is ended by Postgres)
"""

import contextvars
import datetime
import decimal
import json
import logging
import os
import re
import secrets
import smtplib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.sandbox")

bp = Blueprint("portal_sandbox", __name__, url_prefix="/api/v1/portal/sandbox")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name) or default)
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


SCENARIOS_TABLE = os.environ.get("OF_SANDBOX_SCENARIOS_TABLE",
                                 "portal_sandbox_scenarios")
ROLES = tuple(r.strip().lower() for r in (
    os.environ.get("OF_SANDBOX_ROLES") or "owner,admin").split(",")
    if r.strip())
RUNS_PER_HOUR = _env_int("OF_SANDBOX_RUNS_PER_HOUR", 60, 1, 1000)
MAX_HISTORY = _env_int("OF_SANDBOX_MAX_HISTORY", 12, 0, 40)
SCENARIOS_MAX = _env_int("OF_SANDBOX_SCENARIOS_MAX", 50, 1, 500)
TX_SECONDS = _env_int("OF_SANDBOX_TX_SECONDS", 90, 20, 600)
MESSAGE_MAX = 2000
NAME_MAX = 80

# channel option -> (ingest channel, contact id prefix, suffix)
CHANNELS = {
    "whatsapp": ("whatsapp", "0000", "@c.us"),
    "instagram": ("instagram", "ig:sbx", ""),
    "messenger": ("messenger", "fb:sbx", ""),
    "instagram_comment": ("instagram", "igc:sbx", ""),
    "facebook_comment": ("messenger", "fbc:sbx", ""),
}
EXPECT_HANDLERS = ("", "any_reply", "no_reply", "brain", "kb", "away", "cod",
                   "handoff")
HANDLER_LABELS = {
    "brain": "AI brain", "kb": "Knowledge base auto-reply",
    "away": "Away / business-hours reply", "cod": "COD confirmation flow",
    "approvals": "Approval reply", "handoff": "Handed to a person",
    "none": "Nobody replied",
}
BRAIN_REASONS = {
    "needs_human": "The AI decided a person should answer.",
    "low_confidence": "The AI was not confident enough to answer.",
    "injection_suspected": "The message looked like an attempt to change the "
                           "AI's instructions, so it was held for a person.",
    "llm_unavailable": "The AI engine did not answer (no key configured, "
                       "provider down, or a budget / kill switch stopped it).",
    "empty_reply": "The AI returned an empty reply.",
    "agent_draft_only": "The assigned agent may only draft replies "
                        "(Team > Agents > permissions).",
}
_AI_CALLERS = ("portal_llm",)
_AI_PATHS = ("/chat/completions", "/embeddings", "/audio/transcriptions")
# module globals that remember "my table exists" (restored after a run)
_FLAG_RE = re.compile(r"^_[A-Za-z0-9_]*(READY|ready|ensured|ENSURED)$")


# ---------------------------------------------------------------------------
# per-request sandbox state (contextvar - other requests never see it)
# ---------------------------------------------------------------------------

class _Run:
    def __init__(self, conn, force_auto: bool):
        self.conn = conn
        self.force_auto = bool(force_auto)
        self.stack: List[str] = []
        self.counter = 0
        self.blocked: List[Dict[str, str]] = []
        self.usage: List[Dict[str, Any]] = []

    # savepoint stack shared by every _conn() view of the transaction
    def savepoint(self) -> str:
        self.counter += 1
        name = "of_sbx_" + str(self.counter)
        with self.conn.cursor() as cur:
            cur.execute("SAVEPOINT " + name)
        self.stack.append(name)
        return name

    def release(self, name: str) -> None:
        if name not in self.stack:
            return
        index = self.stack.index(name)
        try:
            with self.conn.cursor() as cur:
                cur.execute("RELEASE SAVEPOINT " + name)
        except Exception:
            # aborted transaction: commit means rollback in real life
            self.rollback_to(name)
            with self.conn.cursor() as cur:
                cur.execute("RELEASE SAVEPOINT " + name)
        del self.stack[index:]

    def stack_ok(self) -> bool:
        """Still inside the armed transaction? (a refused COMMIT ends it)"""
        try:
            with self.conn.cursor() as cur:
                cur.execute("SELECT to_regclass('pg_temp.of_sbx_guard') AS t")
                row = cur.fetchone()
            return bool(row and (row[0] if not isinstance(row, dict)
                                 else row.get("t")))
        except Exception:
            return False

    def rollback_to(self, name: str) -> None:
        if name not in self.stack:
            return
        index = self.stack.index(name)
        with self.conn.cursor() as cur:
            cur.execute("ROLLBACK TO SAVEPOINT " + name)
        del self.stack[index + 1:]


_TX_INERROR = 3  # psycopg2.extensions.TRANSACTION_STATUS_INERROR

_STATE: "contextvars.ContextVar[Optional[_Run]]" = contextvars.ContextVar(
    "omniflow_sandbox_run", default=None)


class _SandboxConn:
    """What portal_db._conn() returns during a run: the sandbox transaction
    behind a savepoint. commit = keep the work (release + new savepoint),
    rollback = undo back to this view's savepoint, close = release. The
    real connection is only ever rolled back by run_message()."""

    def __init__(self, run: _Run):
        self._run = run
        self._sp = run.savepoint()
        self.closed = 0

    def cursor(self, *args, **kwargs):
        return self._run.conn.cursor(*args, **kwargs)

    def commit(self) -> None:
        self._run.release(self._sp)
        self._sp = self._run.savepoint()

    def rollback(self) -> None:
        if self._sp in self._run.stack:
            self._run.rollback_to(self._sp)
        else:
            self._sp = self._run.savepoint()

    def close(self) -> None:
        if not self.closed:
            self.closed = 1
            try:
                self._run.release(self._sp)
            except Exception:
                pass

    @property
    def autocommit(self) -> bool:
        return False

    @autocommit.setter
    def autocommit(self, value) -> None:  # never switch the run to autocommit
        return None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False

    def __getattr__(self, name):
        return getattr(self._run.conn, name)


def active() -> bool:
    return _STATE.get() is not None


def autonomy_override(own: str) -> str:
    """portal_brain.effective_autonomy hook: 'Pretend AI is on Auto' lifts
    the workspace's own 'suggest' only (platform caps still apply)."""
    run = _STATE.get()
    if run is not None and run.force_auto and own == "suggest":
        return "auto"
    return own


def capture_usage(client_id: int, feature: str, model: str,
                  prompt_tokens: int, completion_tokens: int,
                  latency_ms: int, ok: bool, agent_id: int = 0) -> bool:
    """portal_ai_usage.record hook: buffer while a run is active (written
    after the rollback, so the real cost is never lost)."""
    run = _STATE.get()
    if run is None:
        return False
    run.usage.append({
        "client_id": int(client_id or 0), "feature": str(feature or "other"),
        "model": str(model or ""), "prompt_tokens": int(prompt_tokens or 0),
        "completion_tokens": int(completion_tokens or 0),
        "latency_ms": int(latency_ms or 0), "ok": bool(ok),
        "agent_id": int(agent_id or 0)})
    return True


# ---------------------------------------------------------------------------
# outside-world guard (installed once; inactive outside a sandbox run)
# ---------------------------------------------------------------------------

def _host(url: str) -> str:
    try:
        return urllib.parse.urlsplit(url).hostname or "?"
    except Exception:
        return "?"


def _caller_module() -> str:
    """First module outside urllib / this file on the call stack."""
    frame = sys._getframe(2)
    while frame is not None:
        name = str(frame.f_globals.get("__name__") or "")
        if name not in ("urllib.request", __name__):
            return name
        frame = frame.f_back
    return ""


def _guarded_open(self, fullurl, *args, **kwargs):
    """OpenerDirector.open - every urllib request (urlopen, build_opener)
    passes here. During a run only portal_llm's model calls get out."""
    run = _STATE.get()
    if run is not None:
        target = fullurl.full_url if isinstance(
            fullurl, urllib.request.Request) else str(fullurl)
        caller = _caller_module()
        path = urllib.parse.urlsplit(target).path.rstrip("/")
        if not (caller in _AI_CALLERS and path.endswith(_AI_PATHS)):
            run.blocked.append({"kind": "http", "target": _host(target),
                                "by": caller})
            raise urllib.error.URLError("blocked by the OmniFlow sandbox")
    return _guarded_open.real(self, fullurl, *args, **kwargs)


def _smtp_guard(base):
    class Guarded(base):  # type: ignore[misc, valid-type]
        def __init__(self, host="", *args, **kwargs):
            run = _STATE.get()
            if run is not None:
                run.blocked.append({"kind": "email", "target": str(host or "?"),
                                    "by": "smtp"})
                raise smtplib.SMTPException("blocked by the OmniFlow sandbox")
            super().__init__(host, *args, **kwargs)
    Guarded.__name__ = base.__name__
    Guarded._of_sandbox = True
    return Guarded


def _install_guards() -> None:
    opener = urllib.request.OpenerDirector
    if not getattr(opener.open, "_of_sandbox", False):
        _guarded_open.real = opener.open
        _guarded_open._of_sandbox = True
        opener.open = _guarded_open
    for name in ("SMTP", "SMTP_SSL"):
        base = getattr(smtplib, name, None)
        if isinstance(base, type) and not getattr(base, "_of_sandbox", False):
            setattr(smtplib, name, _smtp_guard(base))


_install_guards()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _error(message: str, code: str, status: int):
    return jsonify({"error": {"code": code, "message": message}}), status


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable:
        return None, _error("Auth is unavailable, try again.",
                            "portal_unavailable", 503)
    if not principal:
        return None, _error("Sign in required.", "unauthorized", 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    if str(principal.get("role") or "").lower() not in ROLES:
        return None, _error("Only " + " / ".join(ROLES) +
                            " can use the AI sandbox.", "forbidden", 403)
    return principal, None


def _plain(value: Any) -> Any:
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (bytes, memoryview)):
        return None
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _json_obj(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}
    return {}


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(SCENARIOS_TABLE) + " ("
        " id BIGSERIAL PRIMARY KEY,"
        " client_id BIGINT NOT NULL,"
        " name TEXT NOT NULL,"
        " channel TEXT NOT NULL DEFAULT 'whatsapp',"
        " customer_name TEXT NOT NULL DEFAULT '',"
        " message TEXT NOT NULL,"
        " history JSONB NOT NULL DEFAULT '[]'::jsonb,"
        " force_auto BOOLEAN NOT NULL DEFAULT FALSE,"
        " expect_handler TEXT NOT NULL DEFAULT '',"
        " expect_contains TEXT NOT NULL DEFAULT '',"
        " expect_absent TEXT NOT NULL DEFAULT '',"
        " last_pass BOOLEAN,"
        " last_result JSONB,"
        " last_run_at TIMESTAMPTZ,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute(
        "CREATE INDEX IF NOT EXISTS portal_sandbox_scenarios_client_idx ON "
        + portal_db._q(SCENARIOS_TABLE) + " (client_id, id)")
    _DDL_READY = True


_DDL_READY = False


def clean_input(payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    """Validate one run / scenario body -> (clean, "") or (None, reason)."""
    message = str(payload.get("message") or "").strip()
    if not message or len(message) > MESSAGE_MAX:
        return None, ("Type the customer's message (max " + str(MESSAGE_MAX)
                      + " characters).")
    channel = str(payload.get("channel") or "whatsapp").strip().lower()
    if channel not in CHANNELS:
        return None, "channel must be one of: " + ", ".join(CHANNELS) + "."
    customer_name = str(payload.get("customer_name") or "").strip()[:NAME_MAX]
    history_in = payload.get("history") or []
    if not isinstance(history_in, list):
        return None, "history must be a list of earlier turns."
    if len(history_in) > MAX_HISTORY:
        return None, ("At most " + str(MAX_HISTORY) +
                      " earlier turns can be replayed.")
    history = []
    for turn in history_in:
        if not isinstance(turn, dict):
            return None, "Each earlier turn needs a role and a text."
        role = str(turn.get("role") or "").strip().lower()
        text = str(turn.get("text") or "").strip()
        if role not in ("customer", "business") or not text:
            return None, ("Each earlier turn needs role customer or business "
                          "and a text.")
        history.append({"role": role, "text": text[:MESSAGE_MAX]})
    return {"message": message, "channel": channel,
            "customer_name": customer_name or "Test Customer",
            "history": history,
            "force_auto": payload.get("force_auto") is True,
            "simulate_workflows": payload.get("simulate_workflows") is not False}, ""


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------

def _snapshot_flags() -> Dict[str, Dict[str, Any]]:
    snap: Dict[str, Dict[str, Any]] = {}
    for name, module in list(sys.modules.items()):
        if module is None or not (name.startswith(("portal_", "admin_"))
                                  or name in ("connector_api",
                                              "platform_settings")):
            continue
        flags = {k: v for k, v in vars(module).items()
                 if _FLAG_RE.match(k) and isinstance(v, bool)}
        snap[name] = flags
    return snap


def _restore_flags(snap: Dict[str, Dict[str, Any]]) -> None:
    for name, module in list(sys.modules.items()):
        if module is None or not (name.startswith(("portal_", "admin_"))
                                  or name in ("connector_api",
                                              "platform_settings")):
            continue
        before = snap.get(name)
        for key, value in list(vars(module).items()):
            if not (_FLAG_RE.match(key) and isinstance(value, bool)):
                continue
            # modules first imported during the run: "not ready" is always
            # safe (the idempotent DDL simply runs again)
            setattr(module, key, before.get(key, False) if before is not None
                    else False)


def _arm_commit_guard(cur) -> None:
    """A deferred constraint trigger that fails at COMMIT: whatever happens
    inside the run, this transaction can only end in a rollback."""
    cur.execute("CREATE TEMP TABLE of_sbx_guard (x INTEGER) ON COMMIT DROP")
    cur.execute(
        "CREATE OR REPLACE FUNCTION pg_temp.of_sbx_block() RETURNS trigger"
        " LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION"
        " 'OmniFlow sandbox transaction can never be committed'; END $$")
    cur.execute(
        "CREATE CONSTRAINT TRIGGER of_sbx_guard_t AFTER INSERT ON of_sbx_guard"
        " DEFERRABLE INITIALLY DEFERRED FOR EACH ROW"
        " EXECUTE FUNCTION pg_temp.of_sbx_block()")
    cur.execute("INSERT INTO of_sbx_guard VALUES (1)")


def _table_info(cur, table: str) -> Tuple[bool, List[str]]:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AS ok", (portal_db._q(table),))
    found = portal_db.rows(cur)
    if not found or not found[0].get("ok"):
        return False, []
    cur.execute(
        "SELECT attname FROM pg_attribute WHERE attrelid = to_regclass(%s)"
        " AND attnum > 0 AND NOT attisdropped", (portal_db._q(table),))
    return True, [str(r["attname"]) for r in portal_db.rows(cur)]


def _module_attr(module: str, attr: str, default: str) -> str:
    """A module's (env-configurable) table name; default when unavailable."""
    try:
        return str(getattr(__import__(module), attr))
    except Exception:
        return default


def _collectors() -> List[Tuple[str, str, Tuple[str, ...], str]]:
    """(key, table, wanted columns, scope). scope 'conv' = rows of the test
    conversation; 'tx' = any row this transaction wrote for the workspace
    (created_at = transaction_timestamp())."""
    table = _module_attr
    return [
        ("commands", portal_db.CMD_TABLE,
         ("id", "channel", "action", "payload", "status"), "tx"),
        ("escalations", table("portal_escalation", "TABLE",
                              "portal_escalations"),
         ("id", "reason", "source", "severity", "note", "status"), "conv"),
        ("approvals", table("portal_approvals", "TABLE", "portal_approvals"),
         ("id", "action", "summary", "status", "source", "ref_code"), "conv"),
        ("brain", table("portal_brain", "TRACES_TABLE", "portal_brain_traces"),
         ("id", "kind", "decision", "grounding"), "conv"),
        ("workflow_runs", table("portal_workflows", "RUNS_TABLE",
                                "portal_workflow_runs"),
         ("id", "workflow_id", "status", "current_step", "last_error",
          "resume_at"), "conv"),
        ("enrollments", table("portal_sequences", "ENROLLMENTS_TABLE",
                              "portal_sequence_enrollments"),
         ("id", "sequence_id", "status", "current_step", "next_send_at"),
         "conv"),
        ("listen", table("portal_listen", "HITS_TABLE", "portal_listen_hits"),
         ("id", "rule_id", "snippet"), "conv"),
        ("notifications", table("portal_notify", "LEDGER_TABLE",
                                "portal_notifications"),
         ("id", "kind", "severity", "title", "body", "status"), "tx"),
        ("timeline", "portal_action_log",
         ("id", "action", "actor_kind", "conversation_id", "note"), "tx"),
        ("tags", portal_db.CONV_TAGS_TABLE, ("id", "tag"), "conv"),
    ]


def _floors(cur, client_id: int) -> Dict[str, int]:
    floors: Dict[str, int] = {}
    for key, table, _cols, _scope in _collectors():
        cur.execute("SAVEPOINT of_sbx_floor")
        try:
            exists, columns = _table_info(cur, table)
            if exists and "id" in columns:
                cur.execute("SELECT COALESCE(MAX(id), 0) AS n FROM "
                            + portal_db._q(table))
                floors[key] = int((portal_db.rows(cur) or [{}])[0].get("n") or 0)
            cur.execute("RELEASE SAVEPOINT of_sbx_floor")
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT of_sbx_floor")
    return floors


def _collect(cur, client_id: int, conversation_id: int,
             floors: Dict[str, int]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {}
    for key, table, wanted, scope in _collectors():
        out[key] = []
        cur.execute("SAVEPOINT of_sbx_collect")
        try:
            exists, columns = _table_info(cur, table)
            if not exists:
                cur.execute("RELEASE SAVEPOINT of_sbx_collect")
                continue
            cols = [c for c in wanted if c in columns]
            if not cols:
                cur.execute("RELEASE SAVEPOINT of_sbx_collect")
                continue
            where: List[str] = []
            params: List[Any] = []
            if "client_id" in columns:
                where.append("client_id = %s")
                params.append(client_id)
            if scope == "conv":
                if "conversation_id" not in columns:
                    cur.execute("RELEASE SAVEPOINT of_sbx_collect")
                    continue
                where.append("conversation_id = %s")
                params.append(conversation_id)
            else:
                stamp = "created_at" if "created_at" in columns else (
                    "updated_at" if "updated_at" in columns else "")
                if not stamp:
                    cur.execute("RELEASE SAVEPOINT of_sbx_collect")
                    continue
                where.append(stamp + " = transaction_timestamp()")
            if "id" in columns:
                where.append("id > %s")
                params.append(floors.get(key, 0))
            cur.execute(
                "SELECT " + ", ".join(portal_db._q(c) for c in cols) +
                " FROM " + portal_db._q(table) + " WHERE " + " AND ".join(where)
                + (" ORDER BY id" if "id" in columns else "") + " LIMIT 40",
                tuple(params))
            out[key] = [_plain(r) for r in portal_db.rows(cur)]
            cur.execute("RELEASE SAVEPOINT of_sbx_collect")
        except Exception as error:
            logger.warning("sandbox collect %s failed: %s", key, error)
            cur.execute("ROLLBACK TO SAVEPOINT of_sbx_collect")
    out["conversation"] = []
    out["intelligence"] = []
    out["claim"] = []
    out["workflow_steps"] = []
    intel = _module_attr("portal_intelligence", "TABLE", "portal_intelligence")
    run_log = _module_attr("portal_workflows", "RUN_LOG_TABLE",
                           "portal_workflow_run_log")
    for key, sql, params in (
        ("conversation",
         "SELECT * FROM " + portal_db._q(portal_db.CONV_TABLE) +
         " WHERE id = %s AND client_id = %s", (conversation_id, client_id)),
        ("intelligence",
         "SELECT intent, sentiment, sentiment_engine, language,"
         " purchase_intent, urgency, confidence FROM " + portal_db._q(intel) +
         " WHERE client_id = %s AND conversation_id = %s",
         (client_id, conversation_id)),
    ):
        cur.execute("SAVEPOINT of_sbx_collect")
        try:
            cur.execute(sql, params)
            out[key] = [_plain(r) for r in portal_db.rows(cur)]
            cur.execute("RELEASE SAVEPOINT of_sbx_collect")
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT of_sbx_collect")
    run_ids = [int(r["id"]) for r in out.get("workflow_runs") or [] if r.get("id")]
    if run_ids:
        cur.execute("SAVEPOINT of_sbx_collect")
        try:
            cur.execute(
                "SELECT run_id, step_no, kind, outcome, detail FROM"
                " " + portal_db._q(run_log) + " WHERE client_id = %s"
                " AND run_id = ANY(%s) ORDER BY id LIMIT 80",
                (client_id, run_ids))
            out["workflow_steps"] = [_plain(r) for r in portal_db.rows(cur)]
            cur.execute("RELEASE SAVEPOINT of_sbx_collect")
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT of_sbx_collect")
    for key, table, id_key in (
            ("workflow_runs", _module_attr("portal_workflows",
                                           "WORKFLOWS_TABLE",
                                           "portal_workflows"), "workflow_id"),
            ("enrollments", _module_attr("portal_sequences", "SEQUENCES_TABLE",
                                         "portal_sequences"), "sequence_id")):
        ids = sorted({int(r[id_key]) for r in out.get(key) or []
                      if r.get(id_key)})
        if not ids:
            continue
        cur.execute("SAVEPOINT of_sbx_collect")
        try:
            cur.execute("SELECT id, name FROM " + portal_db._q(table) +
                        " WHERE client_id = %s AND id = ANY(%s)",
                        (client_id, ids))
            names = {int(r["id"]): str(r.get("name") or "")
                     for r in portal_db.rows(cur)}
            for row in out[key]:
                row["name"] = names.get(int(row.get(id_key) or 0), "")
            cur.execute("RELEASE SAVEPOINT of_sbx_collect")
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT of_sbx_collect")
    return out


def _advance_workflows(cur, client_id: int, conversation_id: int) -> int:
    """Walk the runs this message started up to their first wait (only the
    test conversation's runs - never another customer's)."""
    advanced = 0
    try:
        import portal_workflows as wf
    except Exception:
        return 0
    cur.execute("SAVEPOINT of_sbx_wf")
    try:
        cur.execute(
            "SELECT r.id, r.workflow_id, r.conversation_id, r.contact_id,"
            " r.contact_name, r.current_step, r.steps_done, r.context"
            " FROM " + portal_db._q(wf.RUNS_TABLE) + " r"
            " WHERE r.client_id = %s AND r.conversation_id = %s"
            " AND r.status IN ('running', 'waiting') AND r.resume_at <= NOW()"
            " ORDER BY r.id LIMIT 10", (client_id, conversation_id))
        runs = portal_db.rows(cur)
        cur.execute("RELEASE SAVEPOINT of_sbx_wf")
    except Exception:
        cur.execute("ROLLBACK TO SAVEPOINT of_sbx_wf")
        return 0
    for run in runs:
        cur.execute("SAVEPOINT of_sbx_wf")
        try:
            steps = wf._load_steps(cur, client_id, int(run["workflow_id"]))
            wf.advance_run(cur, client_id, run, steps)
            cur.execute("RELEASE SAVEPOINT of_sbx_wf")
            advanced += 1
        except Exception as error:
            logger.warning("sandbox workflow step failed: %s", error)
            cur.execute("ROLLBACK TO SAVEPOINT of_sbx_wf")
    return advanced


def _seed_history(cur, client_id: int, channel: str, contact_id: str,
                  name: str, history: List[Dict[str, str]]) -> int:
    """Create the test conversation with the earlier turns (plain rows, no
    automations - they only give the AI its context)."""
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CONV_TABLE) +
        " (client_id, channel, contact_id, contact_name, status,"
        " last_message_preview, last_message_at, created_at, updated_at)"
        " VALUES (%s, %s, %s, %s, 'open', %s, NOW(), NOW(), NOW())"
        " RETURNING id",
        (client_id, channel, contact_id, name, history[-1]["text"][:200]))
    conversation_id = int(portal_db.rows(cur)[0]["id"])
    total = len(history)
    for index, turn in enumerate(history):
        inbound = turn["role"] == "customer"
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
            " (conversation_id, client_id, direction, body, sender_name,"
            " status, created_at) VALUES (%s, %s, %s, %s, %s, %s,"
            " NOW() - make_interval(secs => %s))",
            (conversation_id, client_id, "in" if inbound else "out",
             turn["text"], name if inbound else None,
             "received" if inbound else "sent", (total - index) * 30))
    return conversation_id


def _conversation_id(cur, client_id: int, channel: str,
                     contact_id: str) -> int:
    cur.execute(
        "SELECT id FROM " + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE client_id = %s AND channel = %s AND contact_id = %s",
        (client_id, channel, contact_id))
    found = portal_db.rows(cur)
    return int(found[0]["id"]) if found else 0


def _claim(cur, client_id: int, item_id: str) -> str:
    cur.execute("SAVEPOINT of_sbx_claim")
    try:
        cur.execute(
            "SELECT claimed_by FROM " + portal_db._q(_module_attr(
                "portal_events", "EVENTS_TABLE", "portal_events")) +
            " WHERE client_id = %s"
            " AND idempotency_key = %s ORDER BY id DESC LIMIT 1",
            (client_id, "pid:" + item_id))
        found = portal_db.rows(cur)
        cur.execute("RELEASE SAVEPOINT of_sbx_claim")
        return str((found[0] if found else {}).get("claimed_by") or "")
    except Exception:
        cur.execute("ROLLBACK TO SAVEPOINT of_sbx_claim")
        return ""


def _flush_usage(usage: List[Dict[str, Any]]) -> None:
    if not usage:
        return
    try:
        import portal_ai_usage

        for call in usage:
            portal_ai_usage.record(
                call["client_id"], call["feature"], call["model"],
                call["prompt_tokens"], call["completion_tokens"],
                call["latency_ms"], call["ok"], agent_id=call["agent_id"],
                route="sandbox")
    except Exception as error:
        logger.warning("sandbox usage flush failed: %s", error)


def _autonomy_state(cur, client_id: int) -> Dict[str, Any]:
    state = {"autonomy": "suggest", "effective": "suggest",
             "kill_switch": False, "autonomy_cap": "auto"}
    try:
        import portal_brain

        portal_brain._ensure_ddl(cur)
        settings = portal_brain._load_settings(cur, client_id)
        controls = portal_brain.platform_controls()
        own = str(settings.get("autonomy") or "suggest")
        state.update({
            "autonomy": own,
            "effective": portal_brain.effective_autonomy(own, controls),
            "kill_switch": bool(controls.get("kill_switch")),
            "autonomy_cap": str(controls.get("autonomy_cap") or "auto")})
    except Exception as error:
        logger.warning("sandbox autonomy read failed: %s", error)
    return state


class SandboxBusy(Exception):
    pass


class SandboxUnavailable(Exception):
    pass


def run_message(client_id: int, clean: Dict[str, Any]) -> Dict[str, Any]:
    """One rolled-back pass of the real ingest path. Raises SandboxBusy /
    SandboxUnavailable; everything else is reported inside the result."""
    started = time.time()
    channel, prefix, suffix = CHANNELS[clean["channel"]]
    contact_id = prefix + "".join(secrets.choice("0123456789")
                                  for _ in range(10)) + suffix
    item_id = "sandbox-" + secrets.token_hex(8)
    item = {"from": contact_id, "body": clean["message"],
            "name": clean["customer_name"], "direction": "in",
            "channel": channel, "id": item_id}
    portal_db.ensure_tables()
    conn = portal_db._conn()
    run = _Run(conn, clean["force_auto"])
    flags = _snapshot_flags()
    raw: Dict[str, Any] = {}
    error_text = ""
    conversation_id = 0
    settings: Dict[str, Any] = {}
    try:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL lock_timeout = '3s'")
            cur.execute("SET LOCAL idle_in_transaction_session_timeout = %s",
                        (str(TX_SECONDS) + "s",))
            cur.execute("SELECT pg_try_advisory_xact_lock("
                        "hashtextextended(%s, 0)) AS ok",
                        ("of_sandbox:" + str(client_id),))
            if not (portal_db.rows(cur) or [{}])[0].get("ok"):
                raise SandboxBusy()
            try:
                cur.execute("SAVEPOINT of_sbx_arm")
                _arm_commit_guard(cur)
                cur.execute("RELEASE SAVEPOINT of_sbx_arm")
            except Exception as error:
                logger.warning("sandbox commit guard failed: %s", error)
                raise SandboxUnavailable()
            settings = _autonomy_state(cur, client_id)
            floors = _floors(cur, client_id)
            if clean["history"]:
                conversation_id = _seed_history(
                    cur, client_id, channel, contact_id,
                    clean["customer_name"], clean["history"])
        conn_token = portal_db.SANDBOX_CONN.set(lambda: _SandboxConn(run))
        state_token = _STATE.set(run)
        try:
            try:
                import connector_api

                connector_api.ingest_messages_for_tenant(
                    {"client_id": client_id}, [item])
            except Exception as error:
                error_text = "The message engine stopped: " + str(error)[:160]
                logger.warning("sandbox ingest failed: %s", error)
            if conn.get_transaction_status() != _TX_INERROR:
                try:
                    with conn.cursor() as cur:
                        if not conversation_id:
                            conversation_id = _conversation_id(
                                cur, client_id, channel, contact_id)
                        if conversation_id and clean["simulate_workflows"]:
                            _advance_workflows(cur, client_id, conversation_id)
                except Exception as error:
                    logger.warning("sandbox follow-up failed: %s", error)
        finally:
            _STATE.reset(state_token)
            portal_db.SANDBOX_CONN.reset(conn_token)
        if conn.get_transaction_status() == _TX_INERROR or not run.stack_ok():
            # aborted, or a stray COMMIT ended the transaction (the guard
            # refused it): whatever was collected so far is all there is
            error_text = error_text or ("The simulation hit a database error "
                                        "part way; results may be partial.")
            conn.rollback()
        else:
            with conn.cursor() as cur:
                if conversation_id:
                    raw = _collect(cur, client_id, conversation_id, floors)
                raw["claim"] = [{"claimed_by": _claim(cur, client_id, item_id)}]
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()
            _restore_flags(flags)
            _flush_usage(run.usage)
    return summarize(raw, run, contact_id, clean, settings, error_text,
                     int((time.time() - started) * 1000))


# ---------------------------------------------------------------------------
# result shaping + expectations
# ---------------------------------------------------------------------------

def summarize(raw: Dict[str, Any], run: _Run, contact_id: str,
              clean: Dict[str, Any], settings: Dict[str, Any],
              error_text: str, duration_ms: int) -> Dict[str, Any]:
    replies, others = [], []
    for command in raw.get("commands") or []:
        payload = _json_obj(command.get("payload"))
        if str(command.get("action") or "") != "send_message":
            others.append({"action": str(command.get("action") or ""),
                           "channel": str(command.get("channel") or "")})
            continue
        entry = {"body": str(payload.get("body") or payload.get("text") or ""),
                 "source": str(payload.get("source") or ""),
                 "channel": str(command.get("channel") or "")}
        if str(payload.get("external_user_id") or "") == contact_id:
            replies.append(entry)
        else:
            entry["to"] = "team" if payload.get("external_user_id") else ""
            others.append(entry)
    claim = str(((raw.get("claim") or [{}])[0]).get("claimed_by") or "")
    escalations = raw.get("escalations") or []
    handler = claim or ("handoff" if escalations and not replies else
                        (replies[0]["source"] if replies else "none"))
    brain = None
    traces = raw.get("brain") or []
    if traces:
        trace = traces[-1]
        grounding = _json_obj(trace.get("grounding"))
        reason = str(grounding.get("reason") or "")
        brain = {
            "decision": str(trace.get("decision") or ""),
            "reason": reason,
            "reason_text": (BRAIN_REASONS.get(reason)
                            or ("A business rule blocked the reply ("
                                + reason.split(":", 1)[1] + ")."
                                if reason.startswith("policy:") else "")
                            or ("The output guard withheld the reply."
                                if reason.startswith("output_guard:") else "")),
            "confidence": grounding.get("confidence"),
            "tools": grounding.get("tools") or [],
            "citations": grounding.get("citations") or [],
            "agent_id": grounding.get("agent_id"),
            "llm_called": grounding.get("llm_called"),
        }
    notes: List[str] = []
    effective = str(settings.get("effective") or "")
    if settings.get("kill_switch"):
        notes.append("AI is paused for the whole platform (admin kill switch).")
    elif effective != "auto" and not clean.get("force_auto"):
        notes.append("AI autonomy is '" + (effective or "suggest") + "', so the "
                     "AI brain does not answer customers by itself. Turn on "
                     "'Pretend AI is on Auto' to preview its answer.")
    if clean.get("force_auto") and settings.get("autonomy") == "off":
        notes.append("AI is switched off for this workspace; the sandbox does "
                     "not override that.")
    if clean.get("force_auto") and not settings.get("kill_switch") \
            and settings.get("autonomy") in ("suggest", "auto") \
            and settings.get("autonomy_cap") not in ("auto", "", None):
        notes.append("The platform caps AI autonomy at '" +
                     str(settings.get("autonomy_cap")) + "'.")
    if run.blocked:
        notes.append(str(len(run.blocked)) + " outside call(s) were blocked "
                     "(nothing leaves the sandbox).")
    conversation = (raw.get("conversation") or [{}])[0] if raw.get(
        "conversation") else {}
    routing = {k: conversation.get(k) for k in (
        "status", "assigned_to", "assigned_user_id", "assignee_id",
        "priority", "ai_paused", "snoozed_until") if k in conversation}
    tokens = sum(c["prompt_tokens"] + c["completion_tokens"] for c in run.usage)
    steps_by_run: Dict[int, List[Dict[str, Any]]] = {}
    for step in raw.get("workflow_steps") or []:
        steps_by_run.setdefault(int(step.get("run_id") or 0), []).append(
            {k: step.get(k) for k in ("step_no", "kind", "outcome", "detail")})
    workflows = [{"id": r.get("workflow_id"), "name": r.get("name") or "",
                  "status": r.get("status"), "last_error": r.get("last_error"),
                  "resume_at": r.get("resume_at"),
                  "steps": steps_by_run.get(int(r.get("id") or 0), [])}
                 for r in raw.get("workflow_runs") or []]
    return {
        "ok": not error_text,
        "error": error_text,
        "channel": clean["channel"],
        "message": clean["message"],
        "outcome": {"handler": handler,
                    "handler_label": HANDLER_LABELS.get(handler, handler),
                    "replies": replies, "notes": notes},
        "ai": brain,
        "intelligence": (raw.get("intelligence") or [None])[0],
        "routing": routing,
        "tags": [str(t.get("tag") or t.get("label") or t.get("name") or "")
                 for t in raw.get("tags") or []],
        "handoffs": [{k: e.get(k) for k in ("reason", "severity", "note",
                                            "source")} for e in escalations],
        "approvals": [{k: a.get(k) for k in ("action", "summary", "status")}
                      for a in raw.get("approvals") or []],
        "workflows": workflows,
        "sequences": [{"id": e.get("sequence_id"), "name": e.get("name") or "",
                       "status": e.get("status")}
                      for e in raw.get("enrollments") or []],
        "listen": raw.get("listen") or [],
        "notifications": [{k: n.get(k) for k in ("kind", "severity", "title")}
                          for n in raw.get("notifications") or []],
        "other_messages": others,
        "timeline": [{k: t.get(k) for k in ("action", "actor_kind", "note")}
                     for t in raw.get("timeline") or []],
        "blocked": run.blocked,
        "usage": {"calls": len(run.usage), "tokens": tokens,
                  "failed": sum(1 for c in run.usage if not c["ok"])},
        "settings": {"autonomy": settings.get("autonomy"),
                     "effective": effective,
                     "force_auto": bool(clean.get("force_auto"))},
        "saved": False,
        "duration_ms": duration_ms,
    }


def evaluate(result: Dict[str, Any], expect_handler: str,
             expect_contains: str, expect_absent: str) -> Dict[str, Any]:
    outcome = result.get("outcome") or {}
    replies = outcome.get("replies") or []
    text = " ".join(str(r.get("body") or "") for r in replies).lower()
    checks = []
    if result.get("error"):
        checks.append({"label": "Run finished", "ok": False})
    if expect_handler == "any_reply":
        checks.append({"label": "Customer gets a reply", "ok": bool(replies)})
    elif expect_handler == "no_reply":
        checks.append({"label": "No reply is sent", "ok": not replies})
    elif expect_handler == "handoff":
        checks.append({"label": "Handed to a person",
                       "ok": bool(result.get("handoffs"))})
    elif expect_handler:
        checks.append({"label": "Answered by " + HANDLER_LABELS.get(
            expect_handler, expect_handler),
            "ok": outcome.get("handler") == expect_handler})
    if expect_contains.strip():
        checks.append({"label": 'Reply mentions "' + expect_contains.strip() + '"',
                       "ok": expect_contains.strip().lower() in text})
    if expect_absent.strip():
        checks.append({"label": 'Reply never says "' + expect_absent.strip() + '"',
                       "ok": expect_absent.strip().lower() not in text})
    return {"pass": all(c["ok"] for c in checks) if checks else not result.get(
        "error"), "checks": checks}


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def _rate_ok(client_id: int) -> bool:
    try:
        import portal_ratelimit

        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                allowed = portal_ratelimit.allow(
                    cur, "sandbox:" + str(client_id), RUNS_PER_HOUR, 3600)
            conn.commit()
            return bool(allowed)
        finally:
            conn.close()
    except Exception:
        return True


def _run_or_error(client_id: int, clean: Dict[str, Any]):
    if not _rate_ok(client_id):
        return None, _error("Sandbox limit reached (" + str(RUNS_PER_HOUR) +
                            " runs per hour). Try again later.",
                            "rate_limited", 429)
    try:
        return run_message(client_id, clean), None
    except SandboxBusy:
        return None, _error("Another sandbox run is in progress for this "
                            "workspace. Try again in a moment.", "busy", 409)
    except SandboxUnavailable:
        return None, _error("The database does not allow the sandbox's "
                            "temporary safety table, so nothing was run.",
                            "sandbox_unavailable", 503)
    except Exception as error:
        return None, (jsonify(portal_db.portal_unavailable(
            error, "sandbox run")[0]), 503)


def _shape_scenario(row: Dict[str, Any]) -> Dict[str, Any]:
    history = row.get("history")
    if isinstance(history, str):
        try:
            history = json.loads(history)
        except ValueError:
            history = []
    last = row.get("last_result")
    if isinstance(last, str):
        last = _json_obj(last)
    return {"id": int(row.get("id") or 0), "name": str(row.get("name") or ""),
            "channel": str(row.get("channel") or "whatsapp"),
            "customer_name": str(row.get("customer_name") or ""),
            "message": str(row.get("message") or ""),
            "history": history if isinstance(history, list) else [],
            "force_auto": bool(row.get("force_auto")),
            "expect_handler": str(row.get("expect_handler") or ""),
            "expect_contains": str(row.get("expect_contains") or ""),
            "expect_absent": str(row.get("expect_absent") or ""),
            "last_pass": row.get("last_pass"),
            "last_result": last or None,
            "last_run_at": _plain(row.get("last_run_at"))}


def _db(fn):
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
    except Exception as error:
        return None, (jsonify(portal_db.portal_unavailable(
            error, "sandbox")[0]), 503)
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            out = fn(cur)
        conn.commit()
        return out, None
    except Exception as error:
        conn.rollback()
        return None, (jsonify(portal_db.portal_unavailable(
            error, "sandbox")[0]), 503)
    finally:
        conn.close()


def _clean_scenario(payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    clean, problem = clean_input(payload)
    if clean is None:
        return None, problem
    name = str(payload.get("name") or "").strip()[:NAME_MAX]
    if not name:
        return None, "Give the test a name."
    handler = str(payload.get("expect_handler") or "").strip().lower()
    if handler not in EXPECT_HANDLERS:
        return None, ("expect_handler must be one of: "
                      + ", ".join(h for h in EXPECT_HANDLERS if h) + ".")
    clean.update({
        "name": name, "expect_handler": handler,
        "expect_contains": str(payload.get("expect_contains") or "").strip()[:200],
        "expect_absent": str(payload.get("expect_absent") or "").strip()[:200]})
    return clean, ""


@bp.get("")
def sandbox_overview():
    principal, problem = _principal_or_error()
    if problem:
        return problem
    client_id = int(principal.get("client_id") or 0)

    def load(cur):
        settings = _autonomy_state(cur, client_id)
        cur.execute("SELECT * FROM " + portal_db._q(SCENARIOS_TABLE) +
                    " WHERE client_id = %s ORDER BY id LIMIT %s",
                    (client_id, SCENARIOS_MAX))
        return settings, [_shape_scenario(r) for r in portal_db.rows(cur)]

    out, problem = _db(load)
    if problem:
        return problem
    settings, scenarios = out
    return jsonify({
        "settings": settings,
        "channels": list(CHANNELS),
        "expect_handlers": [h for h in EXPECT_HANDLERS if h],
        "limits": {"runs_per_hour": RUNS_PER_HOUR, "max_history": MAX_HISTORY,
                   "scenarios_max": SCENARIOS_MAX, "message_max": MESSAGE_MAX},
        "scenarios": scenarios,
    }), 200


@bp.post("/run")
def sandbox_run():
    principal, problem = _principal_or_error()
    if problem:
        return problem
    clean, reason = clean_input(request.get_json(silent=True) or {})
    if clean is None:
        return _error(reason, "bad_request", 400)
    result, problem = _run_or_error(int(principal.get("client_id") or 0), clean)
    if problem:
        return problem
    return jsonify(result), 200


@bp.post("/scenarios")
def create_scenario():
    principal, problem = _principal_or_error()
    if problem:
        return problem
    client_id = int(principal.get("client_id") or 0)
    clean, reason = _clean_scenario(request.get_json(silent=True) or {})
    if clean is None:
        return _error(reason, "bad_request", 400)

    def insert(cur):
        cur.execute("SELECT COUNT(*) AS n FROM " + portal_db._q(SCENARIOS_TABLE)
                    + " WHERE client_id = %s", (client_id,))
        if int((portal_db.rows(cur) or [{}])[0].get("n") or 0) >= SCENARIOS_MAX:
            return None
        cur.execute(
            "INSERT INTO " + portal_db._q(SCENARIOS_TABLE) +
            " (client_id, name, channel, customer_name, message, history,"
            " force_auto, expect_handler, expect_contains, expect_absent)"
            " VALUES (%s, %s, %s, %s, %s, CAST(%s AS JSONB), %s, %s, %s, %s)"
            " RETURNING *",
            (client_id, clean["name"], clean["channel"], clean["customer_name"],
             clean["message"], json.dumps(clean["history"], ensure_ascii=False),
             clean["force_auto"], clean["expect_handler"],
             clean["expect_contains"], clean["expect_absent"]))
        return _shape_scenario(portal_db.rows(cur)[0])

    out, problem = _db(insert)
    if problem:
        return problem
    if out is None:
        return _error("You can keep up to " + str(SCENARIOS_MAX) +
                      " saved tests.", "limit_reached", 409)
    return jsonify({"scenario": out}), 201


@bp.put("/scenarios/<int:scenario_id>")
def update_scenario(scenario_id: int):
    principal, problem = _principal_or_error()
    if problem:
        return problem
    client_id = int(principal.get("client_id") or 0)
    clean, reason = _clean_scenario(request.get_json(silent=True) or {})
    if clean is None:
        return _error(reason, "bad_request", 400)

    def update(cur):
        cur.execute(
            "UPDATE " + portal_db._q(SCENARIOS_TABLE) +
            " SET name = %s, channel = %s, customer_name = %s, message = %s,"
            " history = CAST(%s AS JSONB), force_auto = %s,"
            " expect_handler = %s, expect_contains = %s, expect_absent = %s,"
            " last_pass = NULL, last_result = NULL, last_run_at = NULL,"
            " updated_at = NOW() WHERE id = %s AND client_id = %s RETURNING *",
            (clean["name"], clean["channel"], clean["customer_name"],
             clean["message"], json.dumps(clean["history"], ensure_ascii=False),
             clean["force_auto"], clean["expect_handler"],
             clean["expect_contains"], clean["expect_absent"], scenario_id,
             client_id))
        found = portal_db.rows(cur)
        return _shape_scenario(found[0]) if found else None

    out, problem = _db(update)
    if problem:
        return problem
    if out is None:
        return _error("No such saved test.", "not_found", 404)
    return jsonify({"scenario": out}), 200


@bp.delete("/scenarios/<int:scenario_id>")
def delete_scenario(scenario_id: int):
    principal, problem = _principal_or_error()
    if problem:
        return problem
    client_id = int(principal.get("client_id") or 0)

    def delete(cur):
        cur.execute("DELETE FROM " + portal_db._q(SCENARIOS_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (scenario_id, client_id))
        return bool(portal_db.rows(cur))

    out, problem = _db(delete)
    if problem:
        return problem
    if not out:
        return _error("No such saved test.", "not_found", 404)
    return jsonify({"ok": True}), 200


@bp.post("/scenarios/<int:scenario_id>/run")
def run_scenario(scenario_id: int):
    principal, problem = _principal_or_error()
    if problem:
        return problem
    client_id = int(principal.get("client_id") or 0)

    def load(cur):
        cur.execute("SELECT * FROM " + portal_db._q(SCENARIOS_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (scenario_id, client_id))
        found = portal_db.rows(cur)
        return _shape_scenario(found[0]) if found else None

    scenario, problem = _db(load)
    if problem:
        return problem
    if scenario is None:
        return _error("No such saved test.", "not_found", 404)
    clean, reason = clean_input(scenario)
    if clean is None:
        return _error(reason, "bad_request", 400)
    result, problem = _run_or_error(client_id, clean)
    if problem:
        return problem
    verdict = evaluate(result, scenario["expect_handler"],
                       scenario["expect_contains"], scenario["expect_absent"])
    result["verdict"] = verdict
    stored = {"handler": result["outcome"]["handler"],
              "replies": result["outcome"]["replies"][:3],
              "checks": verdict["checks"], "error": result["error"]}

    def save(cur):
        cur.execute(
            "UPDATE " + portal_db._q(SCENARIOS_TABLE) +
            " SET last_pass = %s, last_result = CAST(%s AS JSONB),"
            " last_run_at = NOW() WHERE id = %s AND client_id = %s",
            (verdict["pass"], json.dumps(stored, ensure_ascii=False,
                                         default=str), scenario_id, client_id))
        return True

    _db(save)
    return jsonify(result), 200
