"""Config snapshots + restore (batch 224).

One snapshot = the workspace's configuration at a moment, so a bad change
can be undone in one click. Agents and workflows are NOT here - they keep
their own version history + rollback (portal_agents / portal_workflows).

Areas (a registry - add a row, not a new engine):
    bot          portal_bot_configs        one row per workspace
    profile      portal_profiles           one row
    brain        portal_brain_settings     one row (autonomy, tone)
    brain_facts  portal_brain_facts        many rows (policies, SOPs, pricing)
    workspace    client_settings           one row, ``settings`` JSON merged
    approvals    portal_approvals_config   one row

Laws kept:
- secrets never enter a snapshot: columns / settings keys that look like a
  credential are skipped on capture and left untouched on restore (the
  vault-sealed provider keys live in other tables anyway);
- restore never deletes data: facts created after the snapshot are archived
  (is_active = FALSE), settings keys added after it are kept;
- restore is atomic (the caller's transaction) and always takes a
  "before restore" snapshot first, so a restore can itself be undone;
- schema drift is fine: only columns present in both the snapshot and the
  live table are written;
- ``before_change`` (called by the settings save routes) is fail-soft behind
  a savepoint and grouped: at most one automatic snapshot per
  OF_SNAPSHOT_AUTO_MINUTES (default 30), none when nothing changed.

Env (optional): OF_SNAPSHOT_AUTO_MINUTES=30  OF_SNAPSHOT_KEEP=30 (automatic
ones kept per workspace)  OF_SNAPSHOT_MANUAL_MAX=50  OF_SNAPSHOT_FACTS_MAX=500
"""

import datetime
import decimal
import hashlib
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

bp = Blueprint("portal_snapshots", __name__,
               url_prefix="/api/v1/portal/snapshots")

TABLE = os.environ.get("OF_SNAPSHOTS_TABLE", "portal_config_snapshots")
RESTORE_ROLES = ("owner", "admin")
EXCLUDED_COLUMNS = ("client_id", "id", "updated_at", "updated_by",
                    "created_at")
_SECRET_RE = re.compile(
    r"(secret|token|password|passwd|api[_-]?key|private[_-]?key|salt"
    r"|credential)", re.I)
REASONS = {"manual": "Saved by you", "auto": "Automatic (before a change)",
           "before_restore": "Automatic (before a restore)"}
FACT_COLUMNS = ("kind", "label", "content", "keywords", "is_active")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name) or default)
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def _areas() -> Tuple[Tuple[str, str, str, str], ...]:
    """(key, label, table, shape) - table names follow each module's own
    (env-overridable) constant."""
    approvals_config = os.environ.get("OF_APPROVALS_CONFIG_TABLE",
                                      "portal_approvals_config")
    return (
        ("bot", "Bot settings", portal_db.BOT_TABLE, "row"),
        ("profile", "Business profile", portal_db.PROFILE_TABLE, "row"),
        ("brain", "AI brain settings", "portal_brain_settings", "row"),
        ("brain_facts", "Business facts and policies", "portal_brain_facts",
         "facts"),
        ("workspace", "Workspace settings", "client_settings", "settings"),
        ("approvals", "Approval settings", approvals_config, "row"),
    )


def area_labels() -> Dict[str, str]:
    return {key: label for key, label, _table, _shape in _areas()}


def _secret(name: Any) -> bool:
    return bool(_SECRET_RE.search(str(name or "")))


def _plain(value: Any) -> Any:
    """JSON-safe copy (timestamps -> ISO text, Decimal -> float)."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items() if not _secret(k)}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return None
    return value


def _ensure_ddl(cur) -> None:
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(TABLE) + " ("
        " id BIGSERIAL PRIMARY KEY,"
        " client_id BIGINT NOT NULL,"
        " label TEXT NOT NULL DEFAULT '',"
        " reason TEXT NOT NULL DEFAULT 'manual',"
        " data JSONB NOT NULL DEFAULT '{}'::jsonb,"
        " data_hash TEXT NOT NULL DEFAULT '',"
        " created_by TEXT,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"
        " CREATE INDEX IF NOT EXISTS portal_config_snapshots_client_idx ON "
        + portal_db._q(TABLE) + " (client_id, id DESC)"
    )


def _table_exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS reg", (table,))
    rows = portal_db.rows(cur)
    return bool(rows and rows[0].get("reg"))


def _column_types(cur, table: str) -> Dict[str, str]:
    """{column: data_type} of a live table (drives how values are sent)."""
    cur.execute(
        "SELECT column_name, data_type FROM information_schema.columns"
        " WHERE table_schema = current_schema() AND table_name = %s",
        (table,),
    )
    return {str(r.get("column_name")): str(r.get("data_type") or "")
            for r in portal_db.rows(cur)}


# ---------------------------------------------------------------------------
# capture
# ---------------------------------------------------------------------------

def _capture_area(cur, client_id: int, table: str, shape: str) -> Any:
    if not _table_exists(cur, table):
        return None
    if shape == "facts":
        cur.execute(
            "SELECT * FROM " + portal_db._q(table) +
            " WHERE client_id = %s ORDER BY id LIMIT %s",
            (client_id, _env_int("OF_SNAPSHOT_FACTS_MAX", 500, 1, 5000)),
        )
        out = []
        for row in portal_db.rows(cur):
            item = {"id": row.get("id")}
            for name, value in row.items():
                if name not in EXCLUDED_COLUMNS and not _secret(name):
                    item[name] = _plain(value)
            out.append(item)
        return {"rows": out}
    cur.execute(
        "SELECT * FROM " + portal_db._q(table) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"row": None}
    row = {name: _plain(value) for name, value in rows[0].items()
           if name not in EXCLUDED_COLUMNS and not _secret(name)}
    return {"row": row}


def capture(cur, client_id: int) -> Dict[str, Any]:
    """Current configuration of every area (missing tables are skipped)."""
    data: Dict[str, Any] = {}
    for key, _label, table, shape in _areas():
        cur.execute("SAVEPOINT of_snapshot_area")
        try:
            value = _capture_area(cur, client_id, table, shape)
            cur.execute("RELEASE SAVEPOINT of_snapshot_area")
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT of_snapshot_area")
            value = None
        if value is not None:
            data[key] = value
    return data


def _hash(data: Dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str)
                          .encode("utf-8")).hexdigest()


def take(cur, client_id: int, reason: str, label: str,
         actor: str = "") -> Dict[str, Any]:
    """Store one snapshot of the current configuration. Returns its meta."""
    _ensure_ddl(cur)
    data = capture(cur, client_id)
    cur.execute(
        "INSERT INTO " + portal_db._q(TABLE) +
        " (client_id, label, reason, data, data_hash, created_by)"
        " VALUES (%s, %s, %s, CAST(%s AS JSONB), %s, %s)"
        " RETURNING id, created_at",
        (client_id, str(label or "")[:120], reason,
         json.dumps(data, default=str), _hash(data),
         str(actor or "")[:120] or None),
    )
    created = portal_db.rows(cur)[0]
    _prune(cur, client_id)
    return {"id": created.get("id"), "areas": sorted(data),
            "createdAt": _iso(created.get("created_at"))}


def _prune(cur, client_id: int) -> None:
    """Keep the newest OF_SNAPSHOT_KEEP automatic snapshots; manual ones
    are only removed by the owner."""
    keep = _env_int("OF_SNAPSHOT_KEEP", 30, 1, 500)
    cur.execute(
        "DELETE FROM " + portal_db._q(TABLE) +
        " WHERE client_id = %s AND reason <> 'manual' AND id NOT IN ("
        " SELECT id FROM " + portal_db._q(TABLE) +
        " WHERE client_id = %s AND reason <> 'manual'"
        " ORDER BY id DESC LIMIT %s)",
        (client_id, client_id, keep),
    )


def before_change(cur, client_id: int, area: str,
                  actor: str = "") -> Optional[Dict[str, Any]]:
    """Automatic snapshot before a settings save (grouped + deduplicated).

    Runs inside the caller's transaction behind a savepoint and never
    raises - a snapshot problem must not block the owner's save.
    """
    try:
        cur.execute("SAVEPOINT of_snapshot_auto")
    except Exception:
        return None
    try:
        _ensure_ddl(cur)
        minutes = _env_int("OF_SNAPSHOT_AUTO_MINUTES", 30, 0, 1440)
        cur.execute(
            "SELECT data_hash, created_at > NOW() - (%s || ' minutes')"
            "::interval AS recent FROM " + portal_db._q(TABLE) +
            " WHERE client_id = %s ORDER BY id DESC LIMIT 1",
            (str(minutes), client_id),
        )
        last = portal_db.rows(cur)
        if last and last[0].get("recent"):
            cur.execute("RELEASE SAVEPOINT of_snapshot_auto")
            return None
        data = capture(cur, client_id)
        if not data or (last and last[0].get("data_hash") == _hash(data)):
            cur.execute("RELEASE SAVEPOINT of_snapshot_auto")
            return None
        label = "Before " + area_labels().get(area, area).lower() + " change"
        cur.execute(
            "INSERT INTO " + portal_db._q(TABLE) +
            " (client_id, label, reason, data, data_hash, created_by)"
            " VALUES (%s, %s, 'auto', CAST(%s AS JSONB), %s, %s)"
            " RETURNING id",
            (client_id, label, json.dumps(data, default=str), _hash(data),
             str(actor or "")[:120] or None),
        )
        made = portal_db.rows(cur)
        _prune(cur, client_id)
        cur.execute("RELEASE SAVEPOINT of_snapshot_auto")
        return {"id": made[0].get("id") if made else None}
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT of_snapshot_auto")
        except Exception:
            pass
        return None


# ---------------------------------------------------------------------------
# diff + restore
# ---------------------------------------------------------------------------

def _preview(value: Any) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(
        value, sort_keys=True, default=str)
    return text if len(text) <= 160 else text[:157] + "..."


def _row_changes(current: Optional[Dict[str, Any]],
                 saved: Optional[Dict[str, Any]],
                 shape: str) -> List[Dict[str, str]]:
    changes: List[Dict[str, str]] = []
    if saved is None:
        return changes
    current = current or {}
    for name in sorted(saved):
        if name in EXCLUDED_COLUMNS or _secret(name):
            continue
        before, after = current.get(name), saved.get(name)
        if shape == "settings" and name == "settings" \
                and isinstance(after, dict):
            now = before if isinstance(before, dict) else {}
            for key in sorted(after):
                if _secret(key) or now.get(key) == after.get(key):
                    continue
                changes.append({"field": "settings." + key,
                                "current": _preview(now.get(key)),
                                "snapshot": _preview(after.get(key))})
            continue
        if before != after:
            changes.append({"field": name, "current": _preview(before),
                            "snapshot": _preview(after)})
    return changes


def _fact_changes(current: List[Dict[str, Any]],
                  saved: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    now = {row.get("id"): row for row in current}
    then = {row.get("id"): row for row in saved}
    changes: List[Dict[str, str]] = []
    for fact_id, row in then.items():
        live = now.get(fact_id)
        label = str(row.get("label") or "fact " + str(fact_id))
        if live is None:
            changes.append({"field": label, "current": "(missing)",
                            "snapshot": "brought back"})
            continue
        diff = [c for c in FACT_COLUMNS if c in row and live.get(c) != row.get(c)]
        if diff:
            changes.append({"field": label,
                            "current": _preview({c: live.get(c) for c in diff}),
                            "snapshot": _preview({c: row.get(c) for c in diff})})
    for fact_id, live in now.items():
        if fact_id not in then and live.get("is_active"):
            changes.append({"field": str(live.get("label") or fact_id),
                            "current": "active (added later)",
                            "snapshot": "archived"})
    return changes


def compare(cur, client_id: int, data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Per area: what a restore would change (current -> snapshot)."""
    live = capture(cur, client_id)
    out = []
    for key, label, _table, shape in _areas():
        saved = data.get(key)
        entry = {"key": key, "label": label, "inSnapshot": saved is not None}
        if saved is None:
            entry["changes"] = []
        elif shape == "facts":
            entry["changes"] = _fact_changes(
                (live.get(key) or {}).get("rows") or [],
                saved.get("rows") or [])
        else:
            entry["changes"] = _row_changes(
                (live.get(key) or {}).get("row"), saved.get("row"), shape)
        out.append(entry)
    return out


def _param(value: Any, data_type: str) -> Any:
    """json/jsonb columns get a Json wrapper (any JSON value); everything
    else goes as-is (lists -> SQL arrays, ISO text -> timestamps)."""
    if data_type in ("json", "jsonb") and value is not None:
        from psycopg2.extras import Json

        return Json(value)
    return value


def _keep_secrets(saved: Dict[str, Any], live: Any) -> Dict[str, Any]:
    """Snapshot dict with the live secret keys put back, recursively."""
    live = live if isinstance(live, dict) else {}
    out: Dict[str, Any] = {}
    for key, value in saved.items():
        if _secret(key):
            continue
        out[key] = _keep_secrets(value, live.get(key)) \
            if isinstance(value, dict) else value
    out.update({key: value for key, value in live.items() if _secret(key)})
    return out


def _restore_row(cur, client_id: int, table: str, shape: str,
                 saved: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if saved is None:
        return {"status": "skipped",
                "detail": "Nothing was saved for this area in the snapshot."}
    if not _table_exists(cur, table):
        return {"status": "skipped", "detail": "Not set up on this workspace."}
    live_columns = _column_types(cur, table)
    columns = [name for name in saved
               if name in live_columns and name not in EXCLUDED_COLUMNS
               and not _secret(name)]
    ignored = sorted(name for name in saved if name not in live_columns)
    values = {name: saved[name] for name in columns}
    kept: List[str] = []
    cur.execute("SELECT * FROM " + portal_db._q(table)
                + " WHERE client_id = %s", (client_id,))
    rows = portal_db.rows(cur)
    live = rows[0] if rows else {}
    for name in columns:
        current = live.get(name)
        if not isinstance(values[name], dict) or not isinstance(current, dict):
            continue
        # secrets were never captured: keep the live ones (at any depth)
        merged = _keep_secrets(values[name], current)
        if shape == "settings" and name == "settings":
            # settings added after the snapshot are kept, never dropped
            kept = sorted(key for key in current if key not in merged)
            merged.update({key: current[key] for key in kept})
        values[name] = merged
    if not columns:
        return {"status": "skipped", "detail": "No matching columns."}
    stamp = ", updated_at = NOW()" if "updated_at" in live_columns else ""
    cur.execute(
        "UPDATE " + portal_db._q(table) + " SET "
        + ", ".join(portal_db._q(name) + " = %s" for name in columns)
        + stamp + " WHERE client_id = %s",
        tuple(_param(values[name], live_columns[name]) for name in columns)
        + (client_id,),
    )
    if (getattr(cur, "rowcount", 0) or 0) < 1:
        cur.execute(
            "INSERT INTO " + portal_db._q(table) + " (client_id, "
            + ", ".join(portal_db._q(name) for name in columns) + ") VALUES ("
            + ", ".join(["%s"] * (len(columns) + 1)) + ")",
            (client_id,) + tuple(_param(values[name], live_columns[name])
                                 for name in columns),
        )
    report: Dict[str, Any] = {"status": "restored"}
    if ignored:
        report["ignored"] = ignored
    if kept:
        report["kept"] = kept
    return report


def _restore_facts(cur, client_id: int, table: str,
                   saved: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not _table_exists(cur, table):
        return {"status": "skipped", "detail": "Not set up on this workspace."}
    live_columns = _column_types(cur, table)
    columns = [c for c in FACT_COLUMNS if c in live_columns]
    cur.execute(
        "SELECT id, " + ", ".join(portal_db._q(c) for c in columns) +
        " FROM " + portal_db._q(table) + " WHERE client_id = %s",
        (client_id,),
    )
    live = {row.get("id"): row for row in portal_db.rows(cur)}
    changed = added = archived = 0
    for row in saved:
        fields = [c for c in columns if c in row]
        current = live.get(row.get("id"))
        if current is not None:
            if any(current.get(c) != row.get(c) for c in fields):
                stamp = ", updated_at = NOW()" if "updated_at" in live_columns \
                    else ""
                cur.execute(
                    "UPDATE " + portal_db._q(table) + " SET "
                    + ", ".join(portal_db._q(c) + " = %s" for c in fields)
                    + stamp + " WHERE id = %s AND client_id = %s",
                    tuple(_param(row.get(c), live_columns[c]) for c in fields)
                    + (row.get("id"), client_id),
                )
                changed += 1
            continue
        cur.execute(
            "INSERT INTO " + portal_db._q(table) + " (client_id, "
            + ", ".join(portal_db._q(c) for c in fields) + ") VALUES ("
            + ", ".join(["%s"] * (len(fields) + 1)) + ")",
            (client_id,) + tuple(_param(row.get(c), live_columns[c])
                                 for c in fields),
        )
        added += 1
    saved_ids = {row.get("id") for row in saved}
    if "is_active" in columns:
        for fact_id, current in live.items():
            if fact_id not in saved_ids and current.get("is_active"):
                cur.execute(
                    "UPDATE " + portal_db._q(table) +
                    " SET is_active = FALSE WHERE id = %s AND client_id = %s",
                    (fact_id, client_id),
                )
                archived += 1
    return {"status": "restored", "changed": changed, "added": added,
            "archived": archived}


def restore(cur, client_id: int, snapshot_id: int,
            areas: Optional[List[str]], actor: str) -> Optional[Dict[str, Any]]:
    """Put the chosen areas back as they were in the snapshot.

    Runs in the caller's transaction (all or nothing). Takes a
    "before restore" snapshot first. None when the snapshot is unknown.
    Raises on a database error (the caller rolls back).
    """
    _ensure_ddl(cur)
    cur.execute(
        "SELECT id, label, data FROM " + portal_db._q(TABLE) +
        " WHERE id = %s AND client_id = %s",
        (snapshot_id, client_id),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return None
    data = rows[0].get("data")
    if isinstance(data, str):
        data = json.loads(data or "{}")
    data = data if isinstance(data, dict) else {}
    chosen = [key for key, _l, _t, _s in _areas()
              if key in data and (not areas or key in areas)]
    backup = take(cur, client_id, "before_restore",
                  "Before restoring snapshot #" + str(snapshot_id), actor)
    report = []
    for key, label, table, shape in _areas():
        if key not in chosen:
            continue
        saved = data.get(key) or {}
        if shape == "facts":
            result = _restore_facts(cur, client_id, table,
                                    saved.get("rows") or [])
        else:
            result = _restore_row(cur, client_id, table, shape,
                                  saved.get("row"))
        result.update({"key": key, "label": label})
        report.append(result)
    portal_db.log_action(
        cur, client_id, "config.restored", actor_kind="customer_user",
        note=json.dumps({"snapshot_id": snapshot_id,
                         "backup_id": backup.get("id"),
                         "areas": chosen, "by": actor}, default=str)[:900],
    )
    return {"backupId": backup.get("id"), "areas": report}


# ---------------------------------------------------------------------------
# portal API
# ---------------------------------------------------------------------------

def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except Exception:
        return str(value)


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable:
        return None, (jsonify({"error": {
            "code": "portal_unavailable",
            "message": "Auth is unavailable, try again."}}), 503)
    if not principal:
        return None, (jsonify({"error": {
            "code": "unauthorized", "message": "Sign in required."}}), 401)
    return principal, None


def _writer_error(principal: Dict[str, Any], roles=RESTORE_ROLES):
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    if str(principal.get("role") or "").lower() not in roles:
        return (jsonify({"error": {
            "code": "forbidden",
            "message": "Only " + " / ".join(roles)
                       + " can change configuration snapshots."}}), 403)
    return None


def _actor(principal: Dict[str, Any]) -> str:
    return str(principal.get("email") or principal.get("user_id") or "")


def _meta(row: Dict[str, Any]) -> Dict[str, Any]:
    areas = row.get("areas")
    if isinstance(areas, str):
        try:
            areas = json.loads(areas)
        except Exception:
            areas = []
    return {"id": row.get("id"), "label": row.get("label") or "",
            "reason": row.get("reason"),
            "reasonLabel": REASONS.get(str(row.get("reason")), "Snapshot"),
            "createdBy": row.get("created_by"),
            "createdAt": _iso(row.get("created_at")),
            "areas": sorted(areas or [])}


def _run(fn, context: str):
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                result = fn(cur)
            if isinstance(result, tuple) and len(result) == 2 \
                    and isinstance(result[1], int) and result[1] >= 400:
                conn.rollback()
            else:
                conn.commit()
            return result
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(exc, context)[0]), 503


@bp.get("")
def list_snapshots():
    principal, error = _principal_or_error()
    if error:
        return error

    def work(cur):
        cur.execute(
            "SELECT id, label, reason, created_by, created_at,"
            " (SELECT COALESCE(json_agg(k), '[]'::json)"
            "  FROM jsonb_object_keys(data) AS k) AS areas"
            " FROM " + portal_db._q(TABLE) +
            " WHERE client_id = %s ORDER BY id DESC LIMIT 100",
            (principal["client_id"],),
        )
        return jsonify({
            "snapshots": [_meta(row) for row in portal_db.rows(cur)],
            "areas": [{"key": key, "label": label}
                      for key, label, _t, _s in _areas()],
            "autoMinutes": _env_int("OF_SNAPSHOT_AUTO_MINUTES", 30, 0, 1440),
            "keep": _env_int("OF_SNAPSHOT_KEEP", 30, 1, 500),
            "canRestore": not principal.get("via_api_key") and str(
                principal.get("role") or "").lower() in RESTORE_ROLES,
        }), 200
    return _run(work, "snapshots list")


@bp.post("")
def create_snapshot():
    principal, error = _principal_or_error()
    if error:
        return error
    denied = _writer_error(principal)
    if denied:
        return denied
    payload = request.get_json(silent=True) or {}
    label = str(payload.get("label") or "").strip()[:120] or "Saved snapshot"

    def work(cur):
        cur.execute(
            "SELECT COUNT(*) AS n FROM " + portal_db._q(TABLE) +
            " WHERE client_id = %s AND reason = 'manual'",
            (principal["client_id"],),
        )
        limit = _env_int("OF_SNAPSHOT_MANUAL_MAX", 50, 1, 1000)
        if int((portal_db.rows(cur) or [{}])[0].get("n") or 0) >= limit:
            return jsonify({"error": {
                "code": "limit_reached",
                "message": "You already keep " + str(limit) + " saved"
                           " snapshots - delete an old one first."}}), 409
        made = take(cur, principal["client_id"], "manual", label,
                    _actor(principal))
        portal_db.log_action(
            cur, principal["client_id"], "config.snapshot",
            actor_kind="customer_user",
            note=json.dumps({"snapshot_id": made.get("id"),
                             "label": label}, default=str)[:900])
        return jsonify({"ok": True, "snapshot": dict(
            made, label=label, reason="manual",
            reasonLabel=REASONS["manual"],
            createdBy=_actor(principal))}), 200
    return _run(work, "snapshot create")


@bp.get("/<int:snapshot_id>")
def get_snapshot(snapshot_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    def work(cur):
        cur.execute(
            "SELECT id, label, reason, created_by, created_at, data FROM "
            + portal_db._q(TABLE) + " WHERE id = %s AND client_id = %s",
            (snapshot_id, principal["client_id"]),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return jsonify({"error": {"code": "not_found",
                                      "message": "Snapshot not found."}}), 404
        data = rows[0].get("data")
        if isinstance(data, str):
            data = json.loads(data or "{}")
        data = data if isinstance(data, dict) else {}
        meta = _meta(dict(rows[0], areas=list(data)))
        meta["compare"] = compare(cur, principal["client_id"], data)
        return jsonify({"snapshot": meta}), 200
    return _run(work, "snapshot detail")


@bp.post("/<int:snapshot_id>/restore")
def restore_snapshot(snapshot_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    denied = _writer_error(principal)
    if denied:
        return denied
    payload = request.get_json(silent=True) or {}
    areas = payload.get("areas")
    if areas is not None:
        valid = set(area_labels())
        if not isinstance(areas, list) or not areas \
                or any(str(a) not in valid for a in areas):
            return jsonify({"error": {
                "code": "bad_request",
                "message": "areas must list one or more of: "
                           + ", ".join(sorted(valid)) + "."}}), 400
        areas = [str(a) for a in areas]

    def work(cur):
        result = restore(cur, principal["client_id"], snapshot_id, areas,
                         _actor(principal))
        if result is None:
            return jsonify({"error": {"code": "not_found",
                                      "message": "Snapshot not found."}}), 404
        return jsonify(dict(result, ok=True)), 200
    return _run(work, "snapshot restore")


@bp.delete("/<int:snapshot_id>")
def delete_snapshot(snapshot_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    denied = _writer_error(principal, roles=("owner",))
    if denied:
        return denied

    def work(cur):
        cur.execute(
            "DELETE FROM " + portal_db._q(TABLE) +
            " WHERE id = %s AND client_id = %s RETURNING id",
            (snapshot_id, principal["client_id"]),
        )
        if not portal_db.rows(cur):
            return jsonify({"error": {"code": "not_found",
                                      "message": "Snapshot not found."}}), 404
        portal_db.log_action(
            cur, principal["client_id"], "config.snapshot_deleted",
            actor_kind="customer_user",
            note=json.dumps({"snapshot_id": snapshot_id}))
        return jsonify({"ok": True}), 200
    return _run(work, "snapshot delete")
