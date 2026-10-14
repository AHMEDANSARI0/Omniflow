"""Savepoint guard for fail-soft database steps (§236).

Many hooks run inside one shared transaction (the connector ingest pass,
the connector tick, read helpers called from other modules) and are wrapped
in ``try/except: pass`` so one broken feature never blocks the rest. In
PostgreSQL that is not enough: a failed statement leaves the WHOLE
transaction aborted, so every later hook fails too and the final COMMIT
loses the customer's message. ``savepoint`` scopes one step:

    try:
        with portal_txn.savepoint(cur, conn, "of_hook"):
            portal_cod.maybe_cod_flow(...)
    except Exception:
        pass

* on success the savepoint is released;
* when the step raises, OR swallowed an SQL error itself (the transaction
  status is "in error"), the step's own writes are rolled back and the
  transaction is usable again. The exception is never swallowed here -
  callers keep their existing ``except``; ``guard.failed`` tells whether
  the step was rolled back;
* a step that committed by itself (some hooks do) already ended the
  savepoint - nothing is released then, nothing is rolled back, and work
  it did after its own commit stays in the caller's transaction exactly as
  before (the transaction start time tells a committed step apart).

Savepoints are issued only on connections that report their transaction
status (psycopg2 ``conn.info``). Without that signal a commit inside the
step cannot be told apart from a failure, so the guard steps aside and the
step runs exactly as before.
"""

import logging
from typing import Any, Optional

logger = logging.getLogger("omniflow.portal-txn")

#: psycopg2.extensions TRANSACTION_STATUS_* values (no import needed).
STATUS_IDLE = 0
STATUS_IN_ERROR = 3


def status_of(conn: Any) -> Optional[int]:
    """The server transaction status, or None when the connection cannot
    say (test doubles, wrappers)."""
    try:
        import psycopg2.extensions
        if not isinstance(conn, psycopg2.extensions.connection):
            # wrappers (the sandbox's savepoint views) manage their own
            # savepoints: a "commit" there is not a real one
            return None
        return int(conn.info.transaction_status)
    except Exception:
        return None


class savepoint:
    """Context manager: one fail-soft step inside the caller's transaction."""

    def __init__(self, cur: Any, conn: Any = None, name: str = "of_step"):
        self.cur = cur
        self.conn = conn if conn is not None else getattr(cur, "connection", None)
        self.name = name
        self.active = False
        self.failed = False
        self.started: Any = None

    def __enter__(self) -> "savepoint":
        if status_of(self.conn) is None:
            return self
        try:
            # one round trip: the savepoint plus this transaction's start
            self.cur.execute("SAVEPOINT " + self.name + "; SELECT transaction_timestamp()")
            self.started = _first(self.cur.fetchone())
            self.active = True
        except Exception as error:
            logger.info("savepoint %s not started: %s", self.name, error)
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if not self.active:
            if exc_type is not None:
                self.failed = True
            return False
        state = status_of(self.conn)
        if state == STATUS_IDLE:
            # the step committed: its savepoint ended with that commit
            return False
        if state != STATUS_IN_ERROR and self._committed_inside():
            # it committed and kept working: the savepoint is gone and the
            # later work belongs to the caller's new transaction - keep it
            self.failed = exc_type is not None
            return False
        if exc_type is None and state != STATUS_IN_ERROR:
            try:
                self.cur.execute("RELEASE SAVEPOINT " + self.name)
                return False
            except Exception as error:
                logger.info("savepoint %s release failed: %s", self.name, error)
        self.failed = True
        try:
            self.cur.execute("ROLLBACK TO SAVEPOINT " + self.name)
            self.cur.execute("RELEASE SAVEPOINT " + self.name)
        except Exception as error:
            # the savepoint is gone (the step committed and then failed):
            # only the step's own post-commit work is lost here
            logger.warning("savepoint %s recovery: %s", self.name, error)
            try:
                self.conn.rollback()
            except Exception:
                pass
        return False

    def _committed_inside(self) -> bool:
        """Did the step commit (a new transaction began since __enter__)?"""
        try:
            self.cur.execute("SELECT transaction_timestamp()")
            return _first(self.cur.fetchone()) != self.started
        except Exception as error:
            logger.info("savepoint %s state check failed: %s", self.name, error)
            return False


def _first(row: Any) -> Any:
    if isinstance(row, dict):
        return next(iter(row.values()), None)
    return row[0] if row else None
