"""Tenant-aware rate limiting on the public attack surface (B2).

Fixed-window counters in plain Postgres — no Redis, no extra infra. Every
guarded endpoint calls :func:`allow` once with a bucket key; the counter
resets automatically when the window elapses, and rows from old windows are
pruned whenever a new window starts (so the table stays tiny).

The limiter fails OPEN on database errors: availability beats strict
enforcement, and a broken database already breaks every endpoint anyway.

Limits are environment-tunable (per minute):
  OF_RATE_INGEST_PER_MIN        inbound connector messages per tenant (240)
  OF_RATE_CHECKOUT_PER_MIN      public order-page reads per link (60)
  OF_RATE_CHECKOUT_POST_PER_MIN public writes per link (coupon/change/pay)
"""

import os

import portal_db

RATE_TABLE = os.environ.get("OF_RATE_TABLE", "portal_rate_limits")

INGEST_PER_MIN = int(os.environ.get("OF_RATE_INGEST_PER_MIN", "240") or 240)
CHECKOUT_PER_MIN = int(os.environ.get("OF_RATE_CHECKOUT_PER_MIN", "60") or 60)
CHECKOUT_POST_PER_MIN = int(
    os.environ.get("OF_RATE_CHECKOUT_POST_PER_MIN", "30") or 30
)

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_portal_rate_windows
  ON portal_rate_limits (window_start);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def allow(cur, bucket: str, limit: int, window_seconds: int = 60) -> bool:
    """Count one hit against ``bucket``; True while under ``limit``.

    Fixed window: the row carries the window start; when the window is older
    than ``window_seconds`` the counter restarts at 1. Old rows are pruned
    whenever a counter restarts (cheap, keeps the table at active buckets
    only). Fails open on any database error.
    """
    try:
        _ensure_ddl(cur)
        cur.execute(
            "INSERT INTO " + portal_db._q(RATE_TABLE) +
            " (bucket, window_start, count)"
            " VALUES (%s, NOW(), 1)"
            " ON CONFLICT (bucket) DO UPDATE SET"
            " count = CASE WHEN " + portal_db._q(RATE_TABLE) +
            ".window_start < NOW() - make_interval(secs => %s)"
            "   THEN 1 ELSE " + portal_db._q(RATE_TABLE) + ".count + 1 END,"
            " window_start = CASE WHEN " + portal_db._q(RATE_TABLE) +
            ".window_start < NOW() - make_interval(secs => %s)"
            "   THEN NOW() ELSE " + portal_db._q(RATE_TABLE) +
            ".window_start END"
            " RETURNING count",
            (bucket, window_seconds, window_seconds),
        )
        rows = portal_db.rows(cur)
        count = int(rows[0]["count"]) if rows else 0
        if count <= 1:
            # A fresh window started — prune buckets nobody hit recently.
            cur.execute(
                "DELETE FROM " + portal_db._q(RATE_TABLE) +
                " WHERE window_start < NOW() - make_interval(hours => 1)"
            )
        return count <= max(1, int(limit))
    except Exception:
        return True


def ingest_limit() -> int:
    return INGEST_PER_MIN


def checkout_limit() -> int:
    return CHECKOUT_PER_MIN


def checkout_post_limit() -> int:
    return CHECKOUT_POST_PER_MIN
