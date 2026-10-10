"""§265 OmniFlow Control Plane - website analytics on the tenant database.

Batch 260 shipped the analytics schema for Supabase. The owner runs Neon only,
so §265 moves the same design here: the website sends each recorded event to
the Control Plane (service key, server to server) and the Control Plane stores
it in the same three tables on the tenant database. No SQL to run by hand -
the tables are created the first time a route is called.

Privacy design is unchanged from §260:
  * no cookies, no local storage, no IP address stored - the website sends a
    visitor code it already hashed (salt + day + ip + user agent), and this
    module stores only that code
  * every visit record is deleted once it is older than site_settings
    .retention_days (90 by default, never more than 90); there are no daily
    rollups and no lifetime totals, so nothing older than the window is kept
  * the visitor code is the ONLY identity column

Routes (prefix /api/v1/admin/site-analytics, service key only):
  POST "/event"             store one recorded event
  GET  "/stats?days=N"      the admin numbers (1-90 day window)
  POST "/maintain"          the daily retention job (Vercel Cron)
  GET  "/settings"          retention_days + tz_name
  GET  "/maintenance-log"   recent cleanup runs
"""

import logging
from typing import Any, Callable, Dict, List

from flask import Blueprint, jsonify, request

import portal_auth
import portal_db

log = logging.getLogger("omniflow.portal-site-analytics")

bp = Blueprint("portal_site_analytics", __name__,
               url_prefix="/api/v1/admin/site-analytics")

SETTINGS = "site_settings"
EVENTS = "site_events"
MAINTENANCE_LOG = "site_maintenance_log"

EVENTS_RECORDED = ("page_view", "page_time", "cta_click", "form_submit")
MAX_DAYS = 90
DEFAULT_TZ = "Asia/Karachi"

_DDL = (
    """
    CREATE TABLE IF NOT EXISTS site_settings (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      retention_days INT NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 90),
      tz_name TEXT NOT NULL DEFAULT 'Asia/Karachi',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    "INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
    """
    CREATE TABLE IF NOT EXISTS site_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '/',
      ref_host TEXT NOT NULL DEFAULT '',
      utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '',
      utm_campaign TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT 'desktop',
      browser TEXT NOT NULL DEFAULT 'other',
      country TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '',
      seconds INT NOT NULL DEFAULT 0,
      visitor TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS site_events_created_idx ON site_events (created_at)",
    "CREATE INDEX IF NOT EXISTS site_events_event_idx ON site_events (event, created_at)",
    """
    CREATE TABLE IF NOT EXISTS site_maintenance_log (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retention_days INT NOT NULL,
      cutoff TIMESTAMPTZ NOT NULL,
      raw_deleted BIGINT NOT NULL
    )
    """,
)


class BadInput(ValueError):
    """Input the caller must correct. The message is shown as it is."""


@bp.before_request
def _guard():
    if request.method == "OPTIONS":
        return None
    if not portal_auth.service_key_ok():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403
    return None


def _ensure(cur) -> None:
    for statement in _DDL:
        cur.execute(statement)


_READY = {"done": False}


def _run(work: Callable[[Any], Any]) -> Any:
    """Run work(cur) in one transaction, with the analytics tables ready."""
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            if not _READY["done"]:
                _ensure(cur)
            result = work(cur)
        conn.commit()
        _READY["done"] = True
        return result
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _unavailable(error: Exception, context: str):
    log.warning("site analytics %s unavailable: %s", context, error)
    return jsonify({"error": {"code": "db_unavailable",
                              "message": "Website analytics is unavailable right now."}}), 503


def _bad(message: str):
    return jsonify({"error": {"code": "bad_input", "message": message}}), 400


def _body() -> Dict[str, Any]:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise BadInput("Send a JSON object.")
    return payload


def _clean(payload: Dict[str, Any], key: str, limit: int, fallback: str = "") -> str:
    value = payload.get(key)
    text = fallback if value is None else str(value).strip()
    return text[:limit]


def _clamp_days(value: Any) -> int:
    try:
        days = int(value)
    except (TypeError, ValueError):
        days = 30
    return max(1, min(MAX_DAYS, days))


# ---- event intake ----------------------------------------------------------

@bp.post("/event")
def record_event():
    try:
        payload = _body()
    except BadInput as error:
        return _bad(str(error))
    event = _clean(payload, "event", 24)
    visitor = _clean(payload, "visitor", 64)
    if event not in EVENTS_RECORDED:
        return _bad("Unknown event.")
    if not visitor:
        return _bad("Missing visitor code.")
    try:
        seconds = int(payload.get("seconds") or 0)
    except (TypeError, ValueError):
        seconds = 0
    seconds = max(0, min(seconds, 86400))
    row = (
        event,
        _clean(payload, "path", 512, "/"),
        _clean(payload, "ref_host", 256),
        _clean(payload, "utm_source", 128),
        _clean(payload, "utm_medium", 128),
        _clean(payload, "utm_campaign", 128),
        _clean(payload, "device", 16, "desktop"),
        _clean(payload, "browser", 32, "other"),
        _clean(payload, "country", 8),
        _clean(payload, "lang", 16),
        _clean(payload, "meta", 256),
        seconds,
        visitor,
    )
    try:
        def work(cur):
            cur.execute(
                "INSERT INTO site_events (event, path, ref_host, utm_source,"
                " utm_medium, utm_campaign, device, browser, country, lang,"
                " meta, seconds, visitor) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,"
                "%s,%s,%s,%s)",
                row,
            )
            return None

        _run(work)
        return jsonify({"ok": True}), 200
    except Exception as error:
        return _unavailable(error, "event")


# ---- settings --------------------------------------------------------------

def _settings(cur) -> Dict[str, Any]:
    cur.execute("SELECT retention_days, tz_name FROM site_settings WHERE id = 1")
    row = cur.fetchone()
    if row is None:
        return {"retention_days": MAX_DAYS, "tz_name": DEFAULT_TZ}
    return {"retention_days": int(row[0]), "tz_name": str(row[1] or DEFAULT_TZ)}


@bp.get("/settings")
def settings():
    try:
        return jsonify(_run(_settings)), 200
    except Exception as error:
        return _unavailable(error, "settings")


# ---- stats ------------------------------------------------------------------

_WINDOW = "created_at >= NOW() - make_interval(days => %s)"


def _stats(cur, days: int) -> Dict[str, Any]:
    settings_row = _settings(cur)
    tz = settings_row["tz_name"] or DEFAULT_TZ
    cur.execute("SELECT NOW() - make_interval(days => %s)", (days,))
    since = cur.fetchone()[0]

    cur.execute(
        "SELECT"
        " COUNT(*) FILTER (WHERE event = 'page_view'),"
        " COUNT(DISTINCT visitor),"
        " COUNT(*) FILTER (WHERE event = 'cta_click'),"
        " COUNT(DISTINCT visitor) FILTER (WHERE event = 'cta_click'),"
        " COUNT(*) FILTER (WHERE event = 'form_submit'),"
        " COUNT(DISTINCT visitor) FILTER (WHERE event = 'form_submit'),"
        " COALESCE(ROUND(AVG(seconds) FILTER (WHERE event = 'page_time' AND seconds > 0))::INT, 0)"
        " FROM site_events WHERE " + _WINDOW,
        (days,),
    )
    views, visitors, cta_clicks, cta_visitors, form_submits, form_visitors, avg_seconds = (
        cur.fetchone())

    day_expr = "(e.created_at AT TIME ZONE %s)::date::text"

    cur.execute(
        "SELECT " + day_expr + " AS day, COUNT(*) FILTER (WHERE event = 'page_view'),"
        " COUNT(DISTINCT visitor) FROM site_events e WHERE " + _WINDOW +
        " GROUP BY 1 ORDER BY 1",
        (tz, days),
    )
    daily = [{"day": r[0], "views": int(r[1]), "visitors": int(r[2])}
             for r in cur.fetchall()]

    def top(select: str, where: str, order: str, label: tuple):
        cur.execute(
            "SELECT " + select + " FROM site_events e WHERE " + _WINDOW +
            (" AND " + where if where else "") +
            " GROUP BY 1 ORDER BY " + order + " LIMIT 10",
            (days,),
        )
        return [dict(zip(label, row)) for row in cur.fetchall()]

    pages = top("e.path, COUNT(*), COUNT(DISTINCT visitor)",
                "event = 'page_view'", "2 DESC, 1", ("path", "views", "visitors"))
    sources = top("COALESCE(NULLIF(e.ref_host, ''), 'direct'), COUNT(*),"
                  " COUNT(DISTINCT visitor)",
                  "event = 'page_view'", "2 DESC, 1", ("source", "views", "visitors"))
    cur.execute(
        "SELECT e.utm_source, e.utm_campaign, COUNT(*), COUNT(DISTINCT visitor)"
        " FROM site_events e WHERE " + _WINDOW +
        " AND event = 'page_view' AND e.utm_source <> ''"
        " GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT 10",
        (days,),
    )
    campaigns = [{"utm_source": r[0], "utm_campaign": r[1], "views": int(r[2]),
                  "visitors": int(r[3])} for r in cur.fetchall()]
    countries = top("e.country, COUNT(DISTINCT visitor)", "e.country <> ''",
                    "2 DESC, 1", ("country", "visitors"))
    devices = top("e.device, COUNT(DISTINCT visitor)", "", "2 DESC, 1",
                  ("device", "visitors"))
    browsers = top("e.browser, COUNT(DISTINCT visitor)", "", "2 DESC, 1",
                   ("browser", "visitors"))
    languages = top("e.lang, COUNT(DISTINCT visitor)", "e.lang <> ''",
                    "2 DESC, 1", ("lang", "visitors"))
    clicks = top("e.meta, COUNT(*)", "event = 'cta_click'", "2 DESC, 1",
                 ("target", "clicks"))
    forms = top("e.meta, COUNT(*)", "event = 'form_submit'", "2 DESC, 1",
                ("target", "submits"))

    return {
        "days": days,
        "since": since,
        "timezone": tz,
        "totals": {
            "views": int(views),
            "visitors": int(visitors),
            "cta_clicks": int(cta_clicks),
            "cta_visitors": int(cta_visitors),
            "form_submits": int(form_submits),
            "form_visitors": int(form_visitors),
            "avg_seconds": int(avg_seconds),
        },
        "daily": daily,
        "pages": pages,
        "sources": sources,
        "campaigns": campaigns,
        "countries": countries,
        "devices": devices,
        "browsers": browsers,
        "languages": languages,
        "clicks": clicks,
        "forms": forms,
    }


@bp.get("/stats")
def stats():
    days = _clamp_days(request.args.get("days"))
    try:
        def work(cur):
            return _stats(cur, days)

        return jsonify(_run(work)), 200
    except Exception as error:
        return _unavailable(error, "stats")


# ---- retention --------------------------------------------------------------

def _maintain(cur) -> Dict[str, Any]:
    keep = min(max(int(_settings(cur)["retention_days"]), 1), MAX_DAYS)
    cur.execute("SELECT NOW() - make_interval(days => %s)", (keep,))
    cutoff = cur.fetchone()[0]
    cur.execute("DELETE FROM site_events WHERE created_at < %s", (cutoff,))
    removed = cur.rowcount
    cur.execute("DELETE FROM site_maintenance_log WHERE ran_at < %s", (cutoff,))
    logs_removed = cur.rowcount
    cur.execute(
        "INSERT INTO site_maintenance_log (retention_days, cutoff, raw_deleted)"
        " VALUES (%s, %s, %s)",
        (keep, cutoff, removed),
    )
    return {
        "retention_days": keep,
        "cutoff": cutoff,
        "raw_deleted": int(removed),
        "log_rows_deleted": int(logs_removed),
    }


@bp.post("/maintain")
def maintain():
    try:
        return jsonify(_run(_maintain)), 200
    except Exception as error:
        return _unavailable(error, "maintain")


@bp.get("/maintenance-log")
def maintenance_log():
    limit = _clamp_days(request.args.get("limit", 5))
    limit = max(1, min(limit, 20))

    def work(cur):
        cur.execute(
            "SELECT ran_at, retention_days, raw_deleted FROM site_maintenance_log"
            " ORDER BY ran_at DESC LIMIT %s",
            (limit,),
        )
        return [{"ran_at": r[0], "retention_days": int(r[1]),
                 "raw_deleted": int(r[2])} for r in cur.fetchall()]

    try:
        return jsonify(_run(work)), 200
    except Exception as error:
        return _unavailable(error, "maintenance-log")
