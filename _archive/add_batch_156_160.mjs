// add_batch_156_160.mjs - one-file batch covering Phases 156-160.
//
//   Ph156  NEW control-plane module portal_sequences.py: deterministic
//          multi-step WhatsApp series. CRUD (GET/POST /portal/sequences,
//          PUT/DELETE /portal/sequences/<id>, GET .../enrollments), lazy
//          DDL for portal_sequences + portal_sequence_steps +
//          portal_sequence_enrollments (unique per contact+sequence).
//   Ph157  Automation: the ingest hook enrolls BRAND-NEW contacts (a
//          conversation with exactly one message) into every enabled
//          sequence; the connector poll then delivers due steps (max 5
//          per poll) via the existing command queue - {name} gets the
//          first name, steps wait their delay_hours and the enrollment
//          completes after the last step. No worker, no restart.
//   Ph158  app.py registration + portal.ts clients.
//   Ph159  BFF routes + NEW /dashboard/sequences page (create with a
//          step builder, enable toggle, enrollment counts, per-sequence
//          recent enrollments) + sidebar "Sequences" nav item.
//   Ph160  Regression coverage.
//
// Zero AI. Touches both repos. Vercel deploys on push.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SEQUENCES_MODULE = `"""Deterministic multi-step sequences for brand-new contacts."""

import logging
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth

bp = Blueprint("portal_sequences", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

SEQUENCES_TABLE = "portal_sequences"
STEPS_TABLE = "portal_sequence_steps"
ENROLLMENTS_TABLE = "portal_sequence_enrollments"
MAX_STEPS = 5
MAX_BODY = 1000
MAX_DELAY_HOURS = 168

_SEQ_DDL_READY = False


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    return principal, None


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _ensure_seq_tables(conn) -> None:
    global _SEQ_DDL_READY
    if _SEQ_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SEQUENCES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL,"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(STEPS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " sequence_id BIGINT NOT NULL,"
            " step_no INT NOT NULL,"
            " delay_hours INT NOT NULL DEFAULT 0,"
            " body TEXT NOT NULL)"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(ENROLLMENTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " sequence_id BIGINT NOT NULL,"
            " conversation_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " contact_name TEXT,"
            " current_step INT NOT NULL DEFAULT 0,"
            " next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " status TEXT NOT NULL DEFAULT 'active',"
            " enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " CONSTRAINT uq_sequence_enrollment"
            " UNIQUE (sequence_id, conversation_id))"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due"
            " ON " + portal_db._q(ENROLLMENTS_TABLE) +
            " (client_id, status, next_at)"
        )
    conn.commit()
    _SEQ_DDL_READY = True


def _parse_steps(raw: Any, client_id: int, sequence_id: int, cur) -> Optional[int]:
    """Validate and persist steps; returns count or None when invalid."""
    if not isinstance(raw, list) or not (1 <= len(raw) <= MAX_STEPS):
        return None
    cleaned = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            return None
        body = str(item.get("body") or "").strip()
        if not body or len(body) > MAX_BODY:
            return None
        try:
            delay = int(item.get("delay_hours", 0))
        except (TypeError, ValueError):
            return None
        if delay < 0 or delay > MAX_DELAY_HOURS:
            return None
        if index == 0 and delay < 0:
            return None
        cleaned.append((index + 1, delay, body))
    for step_no, delay, body in cleaned:
        cur.execute(
            "INSERT INTO " + portal_db._q(STEPS_TABLE) +
            " (client_id, sequence_id, step_no, delay_hours, body)"
            " VALUES (%s, %s, %s, %s, %s)",
            (client_id, sequence_id, step_no, delay, body),
        )
    return len(cleaned)


def _steps_public(rows) -> list:
    return [
        {
            "step_no": int(row.get("step_no") or 0),
            "delay_hours": int(row.get("delay_hours") or 0),
            "body": row.get("body") or "",
        }
        for row in rows
    ]


def _sequence_public(row: Dict[str, Any], steps, active_count: int) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("name") or "",
        "enabled": row.get("enabled") is True,
        "created_at": _iso(row.get("created_at")),
        "steps": steps,
        "active_enrollments": active_count,
    }


@bp.get("/sequences")
def list_sequences():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, enabled, created_at FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 20",
                    (principal["client_id"],),
                )
                sequences = portal_db.rows(cur)
                result = []
                for row in sequences:
                    cur.execute(
                        "SELECT step_no, delay_hours, body FROM " + portal_db._q(STEPS_TABLE) +
                        " WHERE client_id = %s AND sequence_id = %s ORDER BY step_no",
                        (principal["client_id"], row.get("id")),
                    )
                    steps = _steps_public(portal_db.rows(cur))
                    cur.execute(
                        "SELECT COUNT(*) AS total FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                        " WHERE client_id = %s AND sequence_id = %s AND status = 'active'",
                        (principal["client_id"], row.get("id")),
                    )
                    counts = portal_db.rows(cur)
                    active_count = int(counts[0].get("total") or 0) if counts else 0
                    result.append(_sequence_public(row, steps, active_count))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("sequences read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "sequences read")[0]), 503
    return jsonify({"sequences": result}), 200


@bp.post("/sequences")
def create_sequence():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()[:120]
    if not name:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "A name is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SEQUENCES_TABLE) +
                    " (client_id, name, enabled) VALUES (%s, %s, FALSE)"
                    " RETURNING id, name, enabled, created_at",
                    (principal["client_id"], name),
                )
                rows = portal_db.rows(cur)
                created = rows[0] if rows else {}
                sequence_id = int(created.get("id") or 0)
                count = _parse_steps(payload.get("steps"), principal["client_id"],
                                     sequence_id, cur)
                if count is None:
                    conn.rollback()
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "Steps: 1 to 5, each with text and a 0-168h delay."}}), 400
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Sequence '" + name + "' with " + str(count) + " steps.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence create")[0]), 503
    return jsonify({"ok": True,
                    "sequence": _sequence_public(created, [], 0)}), 200


@bp.put("/sequences/<int:sequence_id>")
def update_sequence(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    changes = []
    params: list = []
    if "name" in payload:
        name = str(payload.get("name") or "").strip()[:120]
        if not name:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Name cannot be empty."}}), 400
        changes.append("name = %s")
        params.append(name)
    if "enabled" in payload:
        if not isinstance(payload.get("enabled"), bool):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "enabled must be true or false."}}), 400
        changes.append("enabled = %s")
        params.append(payload.get("enabled"))
    if not changes:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Nothing to update."}}), 400
    params.extend([sequence_id, principal["client_id"]])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(SEQUENCES_TABLE) +
                    " SET " + ", ".join(changes) +
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id",
                    tuple(params),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence update")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Sequence not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.delete("/sequences/<int:sequence_id>")
def delete_sequence(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s",
                    (principal["client_id"], sequence_id),
                )
                cur.execute(
                    "DELETE FROM " + portal_db._q(STEPS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s",
                    (principal["client_id"], sequence_id),
                )
                cur.execute(
                    "DELETE FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (sequence_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence delete")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Sequence not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/sequences/<int:sequence_id>/enrollments")
def list_enrollments(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "SELECT id, contact_name, contact_id, current_step, status,"
                    " next_at, enrolled_at FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s"
                    " ORDER BY id DESC LIMIT 20",
                    (principal["client_id"], sequence_id),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollments read")[0]), 503
    return jsonify({"enrollments": [
        {
            "id": row.get("id"),
            "contact_name": row.get("contact_name"),
            "contact_id": row.get("contact_id"),
            "current_step": int(row.get("current_step") or 0),
            "status": row.get("status") or "active",
            "next_at": _iso(row.get("next_at")),
            "enrolled_at": _iso(row.get("enrolled_at")),
        }
        for row in found
    ]}), 200


def maybe_enroll_new_contact(client_id, conversation_id, contact_id,
                             contact_name, conn) -> None:
    """Ingest hook: enroll contacts whose conversation has one message."""
    portal_db.ensure_tables()
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO " + portal_db._q(ENROLLMENTS_TABLE) +
            " (client_id, sequence_id, conversation_id, contact_id, contact_name,"
            " current_step, next_at)"
            " SELECT %s, s.id, %s, %s, %s, 0,"
            " NOW() + make_interval(hours => COALESCE(MIN(st.delay_hours), 0))"
            " FROM " + portal_db._q(SEQUENCES_TABLE) + " s"
            " LEFT JOIN " + portal_db._q(STEPS_TABLE) +
            " st ON st.sequence_id = s.id AND st.step_no = 1"
            " WHERE s.client_id = %s AND s.enabled IS TRUE"
            " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(ENROLLMENTS_TABLE) +
            " e WHERE e.sequence_id = s.id AND e.conversation_id = %s)"
            " AND (SELECT COUNT(*) FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " m WHERE m.conversation_id = %s) <= 1"
            " GROUP BY s.id"
            " RETURNING id",
            (client_id, conversation_id, str(contact_id or ""),
             str(contact_name or ""), client_id, conversation_id, conversation_id),
        )
        enrolled = portal_db.rows(cur)
        if enrolled:
            portal_db.log_action(
                cur,
                client_id,
                "sequence.enrolled",
                "automation",
                None,
                conversation_id,
                "Enrolled " + str(len(enrolled)) + " sequence(s).",
            )


def deliver_due_sequence_steps(cur, client_id: int, conn) -> int:
    """Send due steps for active enrollments (max 5 per poll)."""
    try:
        portal_db.ensure_tables()
        _ensure_seq_tables(conn)
    except Exception:
        return 0
    try:
        cur.execute(
            "SELECT e.id, e.sequence_id, e.current_step, e.contact_id, e.contact_name"
            " FROM " + portal_db._q(ENROLLMENTS_TABLE) + " e"
            " WHERE e.client_id = %s AND e.status = 'active'"
            " AND e.next_at <= NOW()"
            " ORDER BY e.next_at LIMIT 5",
            (client_id,),
        )
        due = portal_db.rows(cur)
        sent = 0
        for row in due:
            current_step = int(row.get("current_step") or 0)
            cur.execute(
                "SELECT step_no, delay_hours, body FROM " + portal_db._q(STEPS_TABLE) +
                " WHERE client_id = %s AND sequence_id = %s AND step_no > %s"
                " ORDER BY step_no LIMIT 2",
                (client_id, row.get("sequence_id"), current_step),
            )
            upcoming = portal_db.rows(cur)
            if not upcoming:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'completed' WHERE id = %s",
                    (row.get("id"),),
                )
                continue
            step = upcoming[0]
            display = str(row.get("contact_name") or "").strip()
            body = str(step.get("body") or "").replace(
                "{name}", (display.split(" ")[0] if display else "there")
            )
            portal_growth._send_command(
                cur, client_id, str(row.get("contact_id") or ""), display,
                body, "sequence", broadcast_id=None,
            )
            finished = len(upcoming) == 1
            if finished:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET current_step = %s, status = 'completed' WHERE id = %s",
                    (int(step.get("step_no") or 0), row.get("id")),
                )
            else:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET current_step = %s,"
                    " next_at = NOW() + make_interval(hours => %s)"
                    " WHERE id = %s",
                    (int(step.get("step_no") or 0),
                     int(upcoming[1].get("delay_hours") or 0), row.get("id")),
                )
            sent += 1
        if sent:
            conn.commit()
        return sent
    except Exception as error:
        logger.warning("sequence delivery pass failed: %s", error)
        return 0
`;

const APP_IMPORT_FROM = `from portal_webhooks import bp as portal_webhooks_bp  # noqa: E402`;
const APP_IMPORT_TO = `from portal_webhooks import bp as portal_webhooks_bp  # noqa: E402
from portal_sequences import bp as portal_sequences_bp  # noqa: E402`;

const APP_REGISTER_FROM = `aux_app.register_blueprint(portal_webhooks_bp)`;
const APP_REGISTER_TO = `aux_app.register_blueprint(portal_webhooks_bp)
aux_app.register_blueprint(portal_sequences_bp)`;

const CONNECTOR_HOOK_FROM = `                try:
                    import portal_webhooks

                    portal_webhooks.deliver_pending_webhooks(
                        cur, tenant["client_id"], conn
                    )
                except Exception:
                    pass`;

const CONNECTOR_HOOK_TO = `                try:
                    import portal_webhooks

                    portal_webhooks.deliver_pending_webhooks(
                        cur, tenant["client_id"], conn
                    )
                except Exception:
                    pass
                try:
                    import portal_sequences

                    portal_sequences.deliver_due_sequence_steps(
                        cur, tenant["client_id"], conn
                    )
                except Exception:
                    pass`;

const COD_TAIL_FROM = `                    except Exception:
                        pass
                    inserted += 1`;

const COD_TAIL_TO = `                    except Exception:
                        pass
                    try:
                        portal_sequences.maybe_enroll_new_contact(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            conn,
                        )
                    except Exception:
                        pass
                    inserted += 1`;

const SEQ_CONNECTOR_IMPORT_FROM = `import portal_db
import portal_cod
`;

const SEQ_CONNECTOR_IMPORT_TO = `import portal_db
import portal_cod
import portal_sequences
`;

const PORTAL_TS_FROM = `export type ConversationStatusResult =`;

const PORTAL_TS_TO = `export interface SequenceStep {
  step_no: number;
  delay_hours: number;
  body: string;
}

export interface SequenceRow {
  id: number;
  name: string;
  enabled: boolean;
  steps: SequenceStep[];
  activeEnrollments: number;
}

export async function listSequences(
  accessToken: string
): Promise<SequenceRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).sequences;
  if (!Array.isArray(rawList)) return null;
  const sequences: SequenceRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    const steps = Array.isArray(row.steps) ? (row.steps as SequenceStep[]) : [];
    sequences.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      enabled: row.enabled === true,
      steps,
      activeEnrollments: typeof row.active_enrollments === "number" ? row.active_enrollments : 0,
    });
  }
  return sequences;
}

export type SequenceMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createSequence(
  accessToken: string,
  name: string,
  steps: { delay_hours: number; body: string }[]
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, steps }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function updateSequence(
  accessToken: string,
  id: number,
  changes: { name?: string; enabled?: boolean }
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function deleteSequence(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SequenceEnrollmentRow {
  id: number;
  contact_name: string | null;
  contact_id: string;
  current_step: number;
  status: string;
  next_at: string | null;
  enrolled_at: string | null;
}

export async function listSequenceEnrollments(
  accessToken: string,
  sequenceId: number
): Promise<SequenceEnrollmentRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).enrollments;
  if (!Array.isArray(rawList)) return null;
  const enrollments: SequenceEnrollmentRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    enrollments.push({
      id: row.id,
      contact_name: typeof row.contact_name === "string" ? row.contact_name : null,
      contact_id: typeof row.contact_id === "string" ? row.contact_id : "",
      current_step: typeof row.current_step === "number" ? row.current_step : 0,
      status: typeof row.status === "string" ? row.status : "active",
      next_at: typeof row.next_at === "string" ? row.next_at : null,
      enrolled_at: typeof row.enrolled_at === "string" ? row.enrolled_at : null,
    });
  }
  return enrollments;
}

export type ConversationStatusResult =`;

const BFF_LIST_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createSequence,
  listSequences,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const sequences = await listSequences(accessToken);
    if (sequences === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Sequences are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ sequences }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const name = typeof input.name === "string" ? input.name : "";
  const steps = Array.isArray(input.steps)
    ? (input.steps as { delay_hours?: unknown; body?: unknown }[]).map(
        (step) => ({
          delay_hours: typeof step.delay_hours === "number" ? step.delay_hours : 0,
          body: typeof step.body === "string" ? step.body : "",
        })
      )
    : [];
  if (!name || steps.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Name and at least one step are required." } },
      400
    );
  }

  try {
    const result = await createSequence(accessToken, name, steps);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Steps: 1 to 5, each with text and a 0-168h delay.",
          },
        },
        400
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const BFF_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteSequence,
  requirePortalAccessToken,
  updateSequence,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const changes: { name?: string; enabled?: boolean } = {};
  if (typeof input.name === "string") changes.name = input.name;
  if (typeof input.enabled === "boolean") changes.enabled = input.enabled;
  if (Object.keys(changes).length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }

  try {
    const result = await updateSequence(accessToken, sequenceId, changes);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Sequence not found." } },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  try {
    const result = await deleteSequence(accessToken, sequenceId);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Sequence not found." } },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const BFF_ENROLLMENTS_FILE = `import {
  listSequenceEnrollments,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  try {
    const enrollments = await listSequenceEnrollments(accessToken, sequenceId);
    if (enrollments === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(JSON.stringify({ enrollments }), {
      status: 200,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const SEQUENCES_PAGE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface Step {
  step_no: number;
  delay_hours: number;
  body: string;
}

interface Sequence {
  id: number;
  name: string;
  enabled: boolean;
  steps: Step[];
  activeEnrollments: number;
}

interface DraftStep {
  delay_hours: number;
  body: string;
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[] | null>(null);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<DraftStep[]>([
    { delay_hours: 0, body: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [enrollments, setEnrollments] = useState<
    { id: number; contact_name: string | null; current_step: number; status: string }[]
  >([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/sequences", {
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const list = (payload as { sequences?: Sequence[] }).sequences;
        setSequences(Array.isArray(list) ? list : []);
      }
    } catch {
      setSequences([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addStep = () => {
    setDraft((current) =>
      current.length < 5
        ? [...current, { delay_hours: 24, body: "" }]
        : current
    );
  };

  const patchStep = (index: number, changes: Partial<DraftStep>) => {
    setDraft((current) =>
      current.map((step, i) => (i === index ? { ...step, ...changes } : step))
    );
  };

  const create = useCallback(async () => {
    if (!name.trim() || draft.some((step) => !step.body.trim())) {
      setNoteTone("amber");
      setNote("Give the series a name and fill every step's message.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, steps: draft }),
      });
      if (response.ok) {
        setNoteTone("emerald");
        setNote("Series created. Toggle it on to enroll new contacts.");
        setName("");
        setDraft([{ delay_hours: 0, body: "" }]);
        void load();
        return;
      }
      setNoteTone("amber");
      setNote("Could not create. Check steps (1-5, 0-168h each).");
    } catch {
      setNoteTone("amber");
      setNote("Could not create. Try again.");
    } finally {
      setBusy(false);
    }
  }, [name, draft, load]);

  const setEnabled = useCallback(
    async (row: Sequence, enabled: boolean) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/sequences/" + String(row.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        void load();
      } catch {
        void load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const remove = useCallback(
    async (row: Sequence) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/sequences/" + String(row.id), {
          method: "DELETE",
        });
        void load();
      } catch {
        void load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const showLog = useCallback(
    async (id: number) => {
      if (openLog === id) {
        setOpenLog(null);
        return;
      }
      setOpenLog(id);
      setEnrollments([]);
      try {
        const response = await fetch(
          "/api/omniflow/portal/sequences/" + String(id) + "/enrollments",
          { cache: "no-store" }
        );
        const payload: unknown = await response.json().catch(() => null);
        if (payload !== null && typeof payload === "object") {
          const list = (payload as { enrollments?: typeof enrollments }).enrollments;
          setEnrollments(Array.isArray(list) ? list : []);
        }
      } catch {
        setEnrollments([]);
      }
    },
    [openLog]
  );

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Sequences</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            A multi-message series that new contacts receive automatically,
            step by step. Great for welcome flows and first-order care.
          </p>
        </div>

        <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-white">New series</h2>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Series name, e.g. Welcome flow"
            className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <div className="mt-3 space-y-2">
            {draft.map((step, index) => (
              <div
                key={index}
                className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">
                    Step {index + 1}
                    {index === 0
                      ? " \\u00b7 sends after this many hours"
                      : " \\u00b7 waits this many hours"}
                  </p>
                  {draft.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current) => current.filter((_, i) => i !== index))
                      }
                      className="text-[11px] text-slate-500 transition hover:text-rose-300"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={168}
                    value={step.delay_hours}
                    onChange={(event) =>
                      patchStep(index, {
                        delay_hours: Math.max(
                          0,
                          Math.min(168, Number(event.target.value) || 0)
                        ),
                      })
                    }
                    className="w-20 shrink-0 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-400/40"
                  />
                  <span className="shrink-0 text-xs text-slate-500">hours</span>
                </div>
                <textarea
                  value={step.body}
                  onChange={(event) => patchStep(index, { body: event.target.value })}
                  rows={2}
                  maxLength={1000}
                  placeholder={"Use {name} and it becomes each customer's first name."}
                  className="mt-2 w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {draft.length < 5 ? (
              <button
                type="button"
                onClick={addStep}
                className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
              >
                + Add step
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {busy ? "Working\\u2026" : "Create series"}
            </button>
            {note ? (
              <p
                className={
                  "text-xs " +
                  (noteTone === "emerald" ? "text-emerald-300" : "text-amber-300")
                }
              >
                {note}
              </p>
            ) : null}
          </div>
        </div>

        {sequences === null ? (
          <p className="text-sm text-slate-500">Loading\\u2026</p>
        ) : sequences.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-8 text-center">
            <p className="text-sm text-slate-400">No series yet.</p>
            <p className="mt-1 text-xs text-slate-600">
              Create one above; every brand-new contact will walk through it.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {sequences.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">{row.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {row.steps.length} step{row.steps.length === 1 ? "" : "s"} \\u00b7{" "}
                      {row.activeEnrollments} active
                      {row.enabled ? " \\u00b7 enrolling" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void setEnabled(row, !row.enabled)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {row.enabled ? "Turn off" : "Turn on"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void showLog(row.id)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {openLog === row.id ? "Hide people" : "People"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(row)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-400/40 hover:text-rose-300"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {openLog === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    {enrollments.length === 0 ? (
                      <p className="text-xs text-slate-500">No enrollments yet.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {enrollments.map((enrollment) => (
                          <li
                            key={enrollment.id}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate text-slate-300">
                              {enrollment.contact_name || "Customer"}
                            </span>
                            <span
                              className={
                                enrollment.status === "completed"
                                  ? "text-emerald-300"
                                  : "text-amber-300"
                              }
                            >
                              {enrollment.status === "completed"
                                ? "completed"
                                : "step " + String(enrollment.current_step + 1) + " pending"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
`;

const NAV_ITEM = '{ label: "Sequences", href: "/dashboard/sequences", icon: "\\u2192", enabled: true }';

function insertNavItem(text) {
  if (text.includes('label: "Sequences"')) {
    return { text, changed: false, anchor: "already" };
  }
  for (const anchorLabel of ["Integrations", "COD confirmations", "Broadcasts", "Conversations"]) {
    const labelIdx = text.indexOf('label: "' + anchorLabel + '"');
    if (labelIdx === -1) continue;
    const start = text.lastIndexOf("{", labelIdx);
    const end = text.indexOf("},", labelIdx);
    if (start === -1 || end === -1) continue;
    const insertAt = end + 2;
    const item = "\n  " + NAV_ITEM + ",";
    return {
      text: text.slice(0, insertAt) + item + text.slice(insertAt),
      changed: true,
      anchor: anchorLabel,
    };
  }
  return { text, changed: false, anchor: null };
}

const NEW_FILES = [
  { path: "OmniFlow-Control-Plane/portal_sequences.py", content: SEQUENCES_MODULE, marker: "maybe_enroll_new_contact", name: "p156-sequences-module" },
  { path: "Omniflow/app/api/omniflow/portal/sequences/route.ts", content: BFF_LIST_FILE, marker: "listSequences", name: "p159-bff-sequences" },
  { path: "Omniflow/app/api/omniflow/portal/sequences/[id]/route.ts", content: BFF_ID_FILE, marker: "deleteSequence", name: "p159-bff-sequence-id" },
  { path: "Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/route.ts", content: BFF_ENROLLMENTS_FILE, marker: "enrollments", name: "p159-bff-enrollments" },
  { path: "Omniflow/app/dashboard/(portal)/sequences/page.tsx", content: SEQUENCES_PAGE, marker: "Sequences", name: "p159-sequences-page" },
];

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      { name: "p158-app-import", from: APP_IMPORT_FROM, to: APP_IMPORT_TO, guard: "portal_sequences" },
      { name: "p158-app-register", from: APP_REGISTER_FROM, to: APP_REGISTER_TO, guard: "register_blueprint(portal_sequences_bp)" },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      { name: "p157-connector-import", from: SEQ_CONNECTOR_IMPORT_FROM, to: SEQ_CONNECTOR_IMPORT_TO, guard: "\nimport portal_sequences\n" },
      { name: "p157-ingest-enroll", from: COD_TAIL_FROM, to: COD_TAIL_TO, guard: "maybe_enroll_new_contact(" },
      { name: "p157-poll-deliver", from: CONNECTOR_HOOK_FROM, to: CONNECTOR_HOOK_TO, guard: "deliver_due_sequence_steps(" },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      { name: "p158-portal-lib", from: PORTAL_TS_FROM, to: PORTAL_TS_TO, guard: "listSequences" },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content.replace(/\r\n/g, "\n"), "utf8");
  if (file.path.endsWith(".py") && !compilePython(file.path)) {
    fs.rmSync(file.path);
    warnTotal++;
    console.log("FAIL (compile failed): " + file.path);
    continue;
  }
  appliedTotal++;
  console.log("+ " + file.path + " (new): " + file.name);
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.guard && text.includes(swap.guard)) {
      alreadyTotal++;
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_b156160.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

if (fs.existsSync("Omniflow/app/dashboard/components/DashSidebar.tsx")) {
  const navPath = "Omniflow/app/dashboard/components/DashSidebar.tsx";
  const navOriginal = fs.readFileSync(navPath, "utf8");
  const navResult = insertNavItem(navOriginal.replace(/\r\n/g, "\n"));
  if (navResult.anchor === "already") {
    alreadyTotal++;
    console.log("= " + navPath + " (nav item already present)");
  } else if (navResult.anchor === null) {
    warnTotal++;
    console.log("  ? " + navPath + " :: p159-nav-item NOT FOUND — paste the navItems block");
  } else {
    const navBackup = navPath + ".pre_b156160.bak";
    if (!fs.existsSync(navBackup)) fs.copyFileSync(navPath, navBackup);
    fs.writeFileSync(navPath, navResult.text, "utf8");
    appliedTotal++;
    console.log("+ " + navPath + " (1): p159-nav-item after " + navResult.anchor);
  }
} else {
  warnTotal++;
  console.log("SKIP (file not found): Omniflow/app/dashboard/components/DashSidebar.tsx");
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);