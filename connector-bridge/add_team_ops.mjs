// add_team_ops.mjs — Phase 8: Team Ops v0 (zero AI cost).
//
// 1. Team members: a portal_team_members table per workspace. The signed-in
//    human is seeded as the workspace "owner" automatically on first use.
//    Owner/admin can add members (email + name + role), change roles
//    (admin/agent), enable/disable and remove them. Owner rows are locked
//    (cannot be demoted/removed through the API) and nobody can change their
//    own role/status (no lockouts).
// 2. Assignment: any conversation can be assigned to an active teammate
//    (or unassigned). The conversations list shows a violet assignee chip;
//    the thread gets an "Assigned to" selector.
// 3. Internal notes: teammates keep notes on a conversation thread. Notes
//    are strictly internal — they are never sent to the customer and need
//    no connector involvement.
//
// Zero bridge changes -> NO bot restart. New portal_team.py blueprint,
// lazy DDL (assigned_to column + portal_team_members + portal_conversation_notes),
// BFF routes, /dashboard/team management page, TeamCard in the thread.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_team_ops.mjs
//
// Requires Phase 7 (add_revenue_ops.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_team.bak
// Expected first run: 25 applied / 0 warnings (18 swaps + 7 new files).
// Expected rerun:     0 applied / 25 already done / 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_team.py";
const BFF_TEAM_PATH = "Omniflow/app/api/omniflow/portal/team/route.ts";
const BFF_TEAM_ID_PATH = "Omniflow/app/api/omniflow/portal/team/[id]/route.ts";
const BFF_ASSIGN_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/[id]/assign/route.ts";
const BFF_NOTES_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/[id]/notes/route.ts";
const TEAM_PAGE_PATH = "Omniflow/app/dashboard/(portal)/team/page.tsx";
const TEAM_CARD_PATH =
  "Omniflow/app/dashboard/(portal)/conversations/[id]/TeamCard.tsx";

const PY_MODULE = `"""Portal team ops (multi-user team, roles, assignment, internal notes).

Team: the workspace owner is seeded automatically from the signed-in
principal on first use; owner/admin manage members (add, change role,
enable/disable, remove). Roles: owner > admin > agent - team management is
owner/admin only; every active member can be assigned conversations and
write internal notes. Notes are strictly internal: they never reach the
customer and require no connector involvement. All deterministic: zero AI
cost, no bridge changes, no bot restart.
"""

import logging
import re
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db


logger = logging.getLogger("omniflow.portal-team")

bp = Blueprint("portal_team", __name__, url_prefix="/api/v1")

TEAM_TABLE = portal_db.TEAM_TABLE
NOTES_TABLE = portal_db.NOTES_TABLE

MANAGE_ROLES = ("owner", "admin")
ASSIGNABLE_ROLES = ("admin", "agent")
MAX_NOTE_BODY = 2000
MAX_NAME_LEN = 80
MAX_EMAIL_LEN = 120
EMAIL_RE = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")


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


def _iso(value) -> Optional[str]:
    """ISO-8601 string for timestamps coming out of the driver, else None."""
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _clean_email(value) -> str:
    return str(value or "").strip().lower()[:MAX_EMAIL_LEN]


def _clean_name(value) -> str:
    return re.sub(r"\\s+", " ", str(value or "").strip())[:MAX_NAME_LEN]


def _member_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "email": row.get("email") or "",
        "name": row.get("name") or "",
        "role": row.get("role") or "agent",
        "status": row.get("status") or "active",
        "created_at": _iso(row.get("created_at")),
    }


def _note_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "author_email": row.get("author_email") or "",
        "author_name": row.get("author_name") or "",
        "body": row.get("body") or "",
        "created_at": _iso(row.get("created_at")),
    }


def _fetch_member_by_id(cur, client_id, member_id) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT id, email, name, role, status, created_at FROM "
        + portal_db._q(TEAM_TABLE) +
        " WHERE id = %s AND client_id = %s LIMIT 1",
        (member_id, client_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _fetch_member_by_email(cur, client_id, email) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT id, email, name, role, status, created_at FROM "
        + portal_db._q(TEAM_TABLE) +
        " WHERE client_id = %s AND email = %s LIMIT 1",
        (client_id, email),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _my_role(cur, client_id, principal) -> Optional[str]:
    email = _clean_email(principal.get("email"))
    if not email:
        return None
    row = _fetch_member_by_email(cur, client_id, email)
    if not row or (row.get("status") or "active") != "active":
        return None
    return row.get("role") or "agent"


def _seed_owner_if_empty(cur, client_id, principal) -> None:
    """First team use seeds the signed-in human as the workspace owner."""
    email = _clean_email(principal.get("email"))
    if not email:
        return
    cur.execute(
        "SELECT 1 FROM " + portal_db._q(TEAM_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    if portal_db.rows(cur):
        return
    cur.execute(
        "INSERT INTO " + portal_db._q(TEAM_TABLE) +
        " (client_id, email, name, role, status)"
        " VALUES (%s, %s, %s, 'owner', 'active')"
        " ON CONFLICT (client_id, email) DO NOTHING",
        (client_id, email, _clean_name(principal.get("display_name"))),
    )


def _conversation_exists(cur, client_id, conversation_id) -> bool:
    cur.execute(
        "SELECT 1 FROM " + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE id = %s AND client_id = %s LIMIT 1",
        (conversation_id, client_id),
    )
    return bool(portal_db.rows(cur))


@bp.get("/portal/team")
def list_team():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _seed_owner_if_empty(cur, client_id, principal)
                cur.execute(
                    "SELECT id, email, name, role, status, created_at FROM "
                    + portal_db._q(TEAM_TABLE) +
                    " WHERE client_id = %s"
                    " ORDER BY CASE WHEN role = 'owner' THEN 0"
                    " WHEN role = 'admin' THEN 1 ELSE 2 END, id ASC",
                    (client_id,),
                )
                members = portal_db.rows(cur)
                my_role = _my_role(cur, client_id, principal)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal team list")[0]), 503
    return jsonify({
        "members": [_member_public(m) for m in members],
        "my_role": my_role,
    }), 200


@bp.post("/portal/team")
def add_team_member():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    payload = request.get_json(silent=True) or {}
    email = _clean_email(payload.get("email"))
    name = _clean_name(payload.get("name"))
    role = str(payload.get("role") or "agent").strip().lower()
    if not email or not EMAIL_RE.match(email):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "A valid email is required."}}), 400
    if role not in ASSIGNABLE_ROLES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "role must be admin or agent."}}), 400
    inserted = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _seed_owner_if_empty(cur, client_id, principal)
                my_role = _my_role(cur, client_id, principal)
                if my_role not in MANAGE_ROLES:
                    return jsonify({"error": {"code": "forbidden_role",
                                              "message": "Only the owner or an admin can manage the team."}}), 403
                cur.execute(
                    "INSERT INTO " + portal_db._q(TEAM_TABLE) +
                    " (client_id, email, name, role, status)"
                    " VALUES (%s, %s, %s, %s, 'active')"
                    " ON CONFLICT (client_id, email) DO NOTHING"
                    " RETURNING id, email, name, role, status, created_at",
                    (client_id, email, name, role),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "email_exists",
                                              "message": "This email is already on the team."}}), 409
                inserted = rows[0]
                portal_db.log_action(
                    cur,
                    client_id,
                    "team.added",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Team member added: " + email + " (" + role + ")",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal team add")[0]), 503
    return jsonify({"ok": True, "member": _member_public(inserted)}), 200


@bp.patch("/portal/team/<int:member_id>")
def update_team_member(member_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    payload = request.get_json(silent=True) or {}
    new_role = payload.get("role")
    new_status = payload.get("status")
    if new_role is None and new_status is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Nothing to update."}}), 400
    if new_role is not None and str(new_role).strip().lower() not in ASSIGNABLE_ROLES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "role must be admin or agent."}}), 400
    if new_status is not None and str(new_status).strip().lower() not in ("active", "disabled"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be active or disabled."}}), 400
    updated = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                my_role = _my_role(cur, client_id, principal)
                if my_role not in MANAGE_ROLES:
                    return jsonify({"error": {"code": "forbidden_role",
                                              "message": "Only the owner or an admin can manage the team."}}), 403
                target = _fetch_member_by_id(cur, client_id, member_id)
                if not target:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Team member not found."}}), 404
                if (target.get("role") or "agent") == "owner":
                    return jsonify({"error": {"code": "owner_locked",
                                              "message": "The workspace owner cannot be changed here."}}), 403
                my_email = _clean_email(principal.get("email"))
                if my_email and str(target.get("email") or "").lower() == my_email:
                    return jsonify({"error": {"code": "self_change_blocked",
                                              "message": "You cannot change your own role or status."}}), 400
                sets = ["updated_at = NOW()"]
                params: List[Any] = []
                if new_role is not None:
                    sets.append("role = %s")
                    params.append(str(new_role).strip().lower())
                if new_status is not None:
                    sets.append("status = %s")
                    params.append(str(new_status).strip().lower())
                params.append(member_id)
                params.append(client_id)
                cur.execute(
                    "UPDATE " + portal_db._q(TEAM_TABLE) +
                    " SET " + ", ".join(sets) +
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, email, name, role, status, created_at",
                    tuple(params),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Team member not found."}}), 404
                updated = rows[0]
                portal_db.log_action(
                    cur,
                    client_id,
                    "team.updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Team member updated: " + str(updated.get("email") or ""),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal team update")[0]), 503
    return jsonify({"ok": True, "member": _member_public(updated)}), 200


@bp.delete("/portal/team/<int:member_id>")
def remove_team_member(member_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    removed_email = ""
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                my_role = _my_role(cur, client_id, principal)
                if my_role not in MANAGE_ROLES:
                    return jsonify({"error": {"code": "forbidden_role",
                                              "message": "Only the owner or an admin can manage the team."}}), 403
                target = _fetch_member_by_id(cur, client_id, member_id)
                if not target:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Team member not found."}}), 404
                if (target.get("role") or "agent") == "owner":
                    return jsonify({"error": {"code": "owner_locked",
                                              "message": "The workspace owner cannot be removed."}}), 403
                my_email = _clean_email(principal.get("email"))
                if my_email and str(target.get("email") or "").lower() == my_email:
                    return jsonify({"error": {"code": "self_change_blocked",
                                              "message": "You cannot remove yourself."}}), 400
                cur.execute(
                    "DELETE FROM " + portal_db._q(TEAM_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING email",
                    (member_id, client_id),
                )
                rows = portal_db.rows(cur)
                removed_email = str(rows[0].get("email") or "") if rows else ""
                portal_db.log_action(
                    cur,
                    client_id,
                    "team.removed",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Team member removed: " + removed_email,
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal team remove")[0]), 503
    return jsonify({"ok": True, "removed_email": removed_email}), 200


@bp.post("/portal/conversations/<int:conversation_id>/assign")
def assign_conversation(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    payload = request.get_json(silent=True) or {}
    raw = payload.get("assignee_email")
    assignee = _clean_email(raw) if raw is not None else ""
    assignee_name = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                if not _conversation_exists(cur, client_id, conversation_id):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                if assignee:
                    _seed_owner_if_empty(cur, client_id, principal)
                    member = _fetch_member_by_email(cur, client_id, assignee)
                    if not member or (member.get("status") or "active") != "active":
                        return jsonify({"error": {"code": "assignee_not_found",
                                                  "message": "That teammate is not an active member."}}), 404
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET assigned_to = %s WHERE id = %s AND client_id = %s",
                    (assignee or None, conversation_id, client_id),
                )
                if assignee:
                    cur.execute(
                        "SELECT name FROM " + portal_db._q(TEAM_TABLE) +
                        " WHERE client_id = %s AND email = %s LIMIT 1",
                        (client_id, assignee),
                    )
                    rows = portal_db.rows(cur)
                    assignee_name = str(rows[0].get("name") or "") if rows else None
                portal_db.log_action(
                    cur,
                    client_id,
                    "conversation.assigned" if assignee else "conversation.unassigned",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    ("Assigned to " + assignee) if assignee else "Assignment cleared.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation assign")[0]), 503
    return jsonify({
        "ok": True,
        "assigned_to": assignee or None,
        "assignee_name": assignee_name,
    }), 200


@bp.get("/portal/conversations/<int:conversation_id>/notes")
def list_notes(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                if not _conversation_exists(cur, client_id, conversation_id):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                cur.execute(
                    "SELECT id, author_email, author_name, body, created_at FROM "
                    + portal_db._q(NOTES_TABLE) +
                    " WHERE conversation_id = %s AND client_id = %s"
                    " ORDER BY id DESC LIMIT 100",
                    (conversation_id, client_id),
                )
                notes = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation notes")[0]), 503
    return jsonify({"notes": [_note_public(n) for n in notes]}), 200


@bp.post("/portal/conversations/<int:conversation_id>/notes")
def add_note(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body") or "").strip()
    if not body:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Note text is required."}}), 400
    if len(body) > MAX_NOTE_BODY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Notes must be 2000 characters or fewer."}}), 400
    note_row = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                if not _conversation_exists(cur, client_id, conversation_id):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                cur.execute(
                    "INSERT INTO " + portal_db._q(NOTES_TABLE) +
                    " (client_id, conversation_id, author_email, author_name, body)"
                    " VALUES (%s, %s, %s, %s, %s)"
                    " RETURNING id, author_email, author_name, body, created_at",
                    (client_id, conversation_id,
                     _clean_email(principal.get("email")),
                     _clean_name(principal.get("display_name")),
                     body),
                )
                rows = portal_db.rows(cur)
                note_row = rows[0] if rows else {}
                portal_db.log_action(
                    cur,
                    client_id,
                    "note.added",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    "Internal note added.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation note add")[0]), 503
    return jsonify({"ok": True, "note": _note_public(note_row or {})}), 200
`;

const BFF_TEAM_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  addTeamMember,
  listTeam,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

const EMAIL_RE = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listTeam(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
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

  const payload = (await request.json().catch(() => null)) as {
    email?: unknown;
    name?: unknown;
    role?: unknown;
  } | null;
  const email =
    typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const role = payload?.role === "admin" ? "admin" : "agent";
  if (!email || email.length > 120 || !EMAIL_RE.test(email)) {
    return safeJson(
      { error: { code: "bad_request", message: "A valid email is required." } },
      400
    );
  }
  if (name.length > 80) {
    return safeJson(
      { error: { code: "bad_request", message: "Name must be 80 characters or fewer." } },
      400
    );
  }

  try {
    const result = await addTeamMember(accessToken, email, name, role);
    if (result.kind === "ok") {
      return safeJson({ ok: true, member: result.member }, 200);
    }
    if (result.kind === "exists") {
      return safeJson(
        { error: { code: "email_exists", message: "This email is already on the team." } },
        409
      );
    }
    if (result.kind === "forbidden") {
      return safeJson(
        {
          error: {
            code: "forbidden_role",
            message: "Only the owner or an admin can manage the team.",
          },
        },
        403
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
`;

const BFF_TEAM_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  removeTeamMember,
  requirePortalAccessToken,
  updateTeamMember,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveMemberId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const memberId = Number(id);
  if (!Number.isInteger(memberId) || memberId <= 0) return null;
  return memberId;
}

function mapMutationResult(result: {
  kind: string;
  member?: unknown;
}): { status: number; body: unknown } {
  if (result.kind === "ok") {
    return { status: 200, body: { ok: true, member: result.member ?? null } };
  }
  if (result.kind === "forbidden") {
    return {
      status: 403,
      body: {
        error: {
          code: "forbidden_role",
          message: "Only the owner or an admin can manage the team.",
        },
      },
    };
  }
  if (result.kind === "exists") {
    return {
      status: 409,
      body: {
        error: { code: "email_exists", message: "This email is already on the team." },
      },
    };
  }
  if (result.kind === "not_found") {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "Team member not found." } },
    };
  }
  return {
    status: 503,
    body: { error: { code: "portal_unavailable", message: "Try again shortly." } },
  };
}

export async function PATCH(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const memberId = await resolveMemberId(context);
  if (memberId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid member id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    role?: unknown;
    status?: unknown;
  } | null;
  const patch: { role?: string; status?: string } = {};
  if (payload?.role === "admin" || payload?.role === "agent") {
    patch.role = payload.role;
  }
  if (payload?.status === "active" || payload?.status === "disabled") {
    patch.status = payload.status;
  }
  if (Object.keys(patch).length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Nothing to update." } },
      400
    );
  }

  try {
    const result = await updateTeamMember(accessToken, memberId, patch);
    const mapped = mapMutationResult(result);
    return safeJson(mapped.body, mapped.status);
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

export async function DELETE(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const memberId = await resolveMemberId(context);
  if (memberId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid member id." } },
      400
    );
  }

  try {
    const result = await removeTeamMember(accessToken, memberId);
    const mapped = mapMutationResult(result);
    return safeJson(mapped.body, mapped.status);
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
`;

const BFF_ASSIGN_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  assignConversation,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveConversationId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return null;
  return conversationId;
}

export async function POST(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    assigneeEmail?: unknown;
  } | null;
  let assigneeEmail: string | null = null;
  if (typeof payload?.assigneeEmail === "string" && payload.assigneeEmail.trim()) {
    assigneeEmail = payload.assigneeEmail.trim().toLowerCase();
    if (assigneeEmail.length > 120) {
      return safeJson(
        { error: { code: "bad_request", message: "Invalid assignee email." } },
        400
      );
    }
  }

  try {
    const result = await assignConversation(accessToken, conversationId, assigneeEmail);
    if (result.kind === "ok") {
      return safeJson(
        {
          ok: true,
          assigned_to: result.assignedTo,
          assignee_name: result.assigneeName,
        },
        200
      );
    }
    if (result.kind === "assignee_not_found") {
      return safeJson(
        {
          error: {
            code: "assignee_not_found",
            message: "That teammate is not an active member.",
          },
        },
        404
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
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
`;

const BFF_NOTES_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  addConversationNote,
  listConversationNotes,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveConversationId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return null;
  return conversationId;
}

export async function GET(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  try {
    const data = await listConversationNotes(accessToken, conversationId);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
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

export async function POST(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    body?: unknown;
  } | null;
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return safeJson(
      { error: { code: "bad_request", message: "Note text is required." } },
      400
    );
  }
  if (body.length > 2000) {
    return safeJson(
      { error: { code: "bad_request", message: "Notes must be 2000 characters or fewer." } },
      400
    );
  }

  try {
    const result = await addConversationNote(accessToken, conversationId, body);
    if (result.kind === "ok") {
      return safeJson({ ok: true, note: result.note }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
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
`;

const TEAM_PAGE_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: "owner" | "admin" | "agent";
  status: string;
}

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

function roleChipClass(role: string): string {
  if (role === "owner") {
    return "border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-300";
  }
  if (role === "admin") {
    return "border-violet-400/25 bg-violet-400/[0.08] text-violet-300";
  }
  return "border-white/[0.08] bg-white/[0.03] text-slate-400";
}

export default function TeamPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("agent");
  const [busy, setBusy] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const canManage = myRole === "owner" || myRole === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/omniflow/portal/team", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        members?: TeamMember[];
        myRole?: string | null;
      } | null;
      if (payload) {
        setMembers(Array.isArray(payload.members) ? payload.members : []);
        setMyRole(
          payload.myRole === "owner" || payload.myRole === "admin" || payload.myRole === "agent"
            ? payload.myRole
            : null
        );
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addMember() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), role }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Teammate added." });
        setName("");
        setEmail("");
        setRole("agent");
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not add the teammate. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function patchMember(memberId: number, patch: Record<string, string>) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/team/" + String(memberId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not update the teammate. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(memberId: number) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/team/" + String(memberId), {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Teammate removed." });
        setConfirmRemoveId(null);
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not remove the teammate. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-cyan-300 transition-colors hover:text-cyan-200"
          >
            Re-authenticate →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Team</h1>
        <p className="mt-1 text-sm text-slate-400">
          Add teammates, assign conversations and keep internal notes — notes
          are never sent to customers.
        </p>
      </div>

      {canManage && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <h2 className="text-xs font-semibold text-white">Add teammate</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name (e.g. Ahmed)"
              maxLength={80}
              className={inputClass}
            />
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email (e.g. ali@gmail.com)"
              maxLength={120}
              type="email"
              className={inputClass}
            />
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className={inputClass}
            >
              <option value="agent">Agent — assigned chats + notes</option>
              <option value="admin">Admin — manages the team too</option>
            </select>
            <button
              type="button"
              onClick={addMember}
              disabled={busy || !email.trim()}
              className={primaryBtn + " w-full sm:w-auto sm:justify-self-end"}
            >
              {busy ? "Working…" : "Add teammate"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={
            "mt-4 text-xs " +
            (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
          }
        >
          {message.text}
        </p>
      )}

      <div className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Members
        </h2>
        {loading ? (
          <div className="mt-3 animate-pulse space-y-3">
            <div className="h-16 rounded-2xl border border-white/[0.06] bg-white/[0.02]" />
            <div className="h-16 rounded-2xl border border-white/[0.06] bg-white/[0.02]" />
          </div>
        ) : loadError ? (
          <div className="mt-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-6 text-center">
            <p className="text-sm text-slate-300">
              The team module is rolling out on the server — try again in a
              couple of minutes.
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {members.map((member) => {
              const isSelf =
                member.role === "owner" && member.status === "active" && myRole === "owner";
              const locked = member.role === "owner";
              return (
                <li
                  key={member.id}
                  className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-sm font-semibold text-slate-300">
                        {(member.name || member.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">
                          {member.name || member.email}
                        </p>
                        <p className="truncate text-[11px] text-slate-500">{member.email}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={
                          "rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                          roleChipClass(member.role)
                        }
                      >
                        {member.role}
                      </span>
                      <span
                        className={
                          "rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                          (member.status === "active"
                            ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                            : "border-white/[0.08] bg-white/[0.03] text-slate-500")
                        }
                      >
                        {member.status}
                      </span>
                    </div>
                  </div>
                  {canManage && !locked && (
                    <div className="mt-3 flex flex-col gap-2 border-t border-white/[0.06] pt-3 sm:flex-row sm:items-center sm:justify-end">
                      <select
                        value={member.role}
                        onChange={(event) =>
                          patchMember(member.id, { role: event.target.value })
                        }
                        disabled={busy}
                        className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none transition-colors duration-300 focus:border-cyan-400/40 disabled:opacity-50 sm:w-44"
                      >
                        <option value="agent">Agent</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          patchMember(member.id, {
                            status: member.status === "active" ? "disabled" : "active",
                          })
                        }
                        disabled={busy}
                        className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50 sm:w-auto"
                      >
                        {member.status === "active" ? "Disable" : "Enable"}
                      </button>
                      {confirmRemoveId === member.id ? (
                        <button
                          type="button"
                          onClick={() => removeMember(member.id)}
                          disabled={busy}
                          className="w-full rounded-xl border border-red-400/25 bg-red-400/[0.08] px-4 py-2 text-xs font-medium text-red-300 transition-colors duration-300 hover:bg-red-400/[0.14] disabled:opacity-50 sm:w-auto"
                        >
                          Confirm remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(member.id)}
                          disabled={busy}
                          className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-400 transition-colors duration-300 hover:border-red-400/25 hover:text-red-300 disabled:opacity-50 sm:w-auto"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <h2 className="text-xs font-semibold text-white">How roles work</h2>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-slate-500">
          <li>
            <span className="font-semibold text-slate-300">Owner</span> — you.
            Manages the team; the owner seat cannot be removed by mistake.
          </li>
          <li>
            <span className="font-semibold text-slate-300">Admin</span> — can
            also add/remove teammates and change roles.
          </li>
          <li>
            <span className="font-semibold text-slate-300">Agent</span> — works
            conversations: assignment and internal notes.
          </li>
        </ul>
      </div>
    </div>
  );
}
`;

const TEAM_CARD_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface TeamMemberLite {
  id: number;
  email: string;
  name: string;
  status: string;
}

interface NoteEntry {
  id: number;
  authorEmail: string;
  authorName: string;
  body: string;
  createdAt: string | null;
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function TeamCard({
  conversationId,
  initialAssignedTo,
}: {
  conversationId: number;
  initialAssignedTo: string | null;
}) {
  const [members, setMembers] = useState<TeamMemberLite[]>([]);
  const [assignedTo, setAssignedTo] = useState<string | null>(initialAssignedTo);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyAssign, setBusyAssign] = useState(false);
  const [busyNote, setBusyNote] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const loadNotes = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/notes",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        notes?: NoteEntry[];
      } | null;
      if (payload && Array.isArray(payload.notes)) {
        setNotes(payload.notes);
        setNotesLoaded(true);
      }
    } catch {
      // Transient network issue — reopening the thread retries.
    }
  }, [conversationId]);

  useEffect(() => {
    let alive = true;
    async function loadTeam() {
      try {
        const response = await fetch("/api/omniflow/portal/team", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          members?: TeamMemberLite[];
        } | null;
        if (alive && payload && Array.isArray(payload.members)) {
          setMembers(payload.members);
        }
      } catch {
        // The selector still works with the current assignee only.
      }
    }
    void loadTeam();
    void loadNotes();
    return () => {
      alive = false;
    };
  }, [loadNotes]);

  async function assign(email: string) {
    if (busyAssign) return;
    setBusyAssign(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/assign",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ assigneeEmail: email || null }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        assigned_to?: string | null;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setAssignedTo(payload.assigned_to ?? null);
        setMessage({
          kind: "ok",
          text: email ? "Conversation assigned." : "Assignment cleared.",
        });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not assign. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusyAssign(false);
    }
  }

  async function addNote() {
    if (busyNote || !draft.trim()) return;
    setBusyNote(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/notes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body: draft.trim() }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        note?: NoteEntry | null;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        if (payload.note) {
          setNotes((current) => [payload.note as NoteEntry, ...current]);
        } else {
          await loadNotes();
        }
        setDraft("");
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save the note. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusyNote(false);
    }
  }

  const activeMembers = members.filter((member) => member.status === "active");

  return (
    <div className="mb-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-white">Team</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            Assign this conversation and keep internal notes — notes stay
            private to your team.
          </p>
        </div>
        <select
          value={assignedTo ?? ""}
          onChange={(event) => assign(event.target.value)}
          disabled={busyAssign}
          className="w-full shrink-0 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none transition-colors duration-300 focus:border-cyan-400/40 disabled:opacity-50 sm:w-56"
        >
          <option value="">Unassigned</option>
          {activeMembers.map((member) => (
            <option key={member.id} value={member.email}>
              {member.name || member.email}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 border-t border-white/[0.06] pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Internal notes
        </h3>
        {notesLoaded && notes.length === 0 ? (
          <p className="mt-2 text-[11px] text-slate-600">No notes yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {notes.map((note) => (
              <li
                key={note.id}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
              >
                <p className="text-[10px] uppercase tracking-wider text-slate-600">
                  {note.authorName || note.authorEmail}
                  {note.createdAt ? " · " + formatWhen(note.createdAt) : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-300">
                  {note.body}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Internal note — never sent to the customer"
            className="w-full resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <button
            type="button"
            onClick={addNote}
            disabled={busyNote || !draft.trim()}
            className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50 sm:w-auto"
          >
            {busyNote ? "Saving…" : "Add note"}
          </button>
        </div>
        {message && (
          <p
            className={
              "mt-2 text-[11px] " +
              (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
`;

const PORTAL_TS_TEAM_SECTION = `// ---------------------------------------------------------------------------
// Team (multi-user roles, assignment) + internal conversation notes
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "admin" | "agent";

export interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: TeamRole;
  status: string;
  createdAt: string | null;
}

export interface TeamOverview {
  members: TeamMember[];
  myRole: TeamRole | null;
}

export interface NoteEntry {
  id: number;
  authorEmail: string;
  authorName: string;
  body: string;
  createdAt: string | null;
}

export type TeamMutationResult =
  | { kind: "ok"; member: TeamMember | null }
  | { kind: "forbidden" }
  | { kind: "exists" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export type AssignConversationResult =
  | { kind: "ok"; assignedTo: string | null; assigneeName: string | null }
  | { kind: "not_found" }
  | { kind: "assignee_not_found" }
  | { kind: "unavailable" };

export type NoteAddResult =
  | { kind: "ok"; note: NoteEntry | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeTeamMember(value: unknown): TeamMember | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const email = typeof p.email === "string" ? p.email : "";
  if (id === null || !email) return null;
  const role: TeamRole = p.role === "owner" || p.role === "admin" ? p.role : "agent";
  return {
    id,
    email,
    name: typeof p.name === "string" ? p.name : "",
    role,
    status: p.status === "disabled" ? "disabled" : "active",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

function normalizeNoteEntry(value: unknown): NoteEntry | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    authorEmail: typeof p.author_email === "string" ? p.author_email : "",
    authorName: typeof p.author_name === "string" ? p.author_name : "",
    body: typeof p.body === "string" ? p.body : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listTeam(
  accessToken: string
): Promise<TeamOverview | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/team");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawMembers = Array.isArray(p.members) ? p.members : [];
  const members: TeamMember[] = [];
  for (const raw of rawMembers) {
    const member = normalizeTeamMember(raw);
    if (member) members.push(member);
  }
  const myRole =
    p.my_role === "owner" || p.my_role === "admin" || p.my_role === "agent"
      ? p.my_role
      : null;
  return { members, myRole };
}

async function teamMutation(
  accessToken: string,
  path: string,
  init: RequestInit
): Promise<TeamMutationResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path, init);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 409) return { kind: "exists" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "ok", member: null };
  }
  const member = normalizeTeamMember(
    (payload as Record<string, unknown>).member
  );
  return { kind: "ok", member };
}

export async function addTeamMember(
  accessToken: string,
  email: string,
  name: string,
  role: "admin" | "agent"
): Promise<TeamMutationResult> {
  return teamMutation(accessToken, "api/v1/portal/team", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name, role }),
  });
}

export async function updateTeamMember(
  accessToken: string,
  memberId: number,
  patch: { role?: string; status?: string }
): Promise<TeamMutationResult> {
  return teamMutation(
    accessToken,
    "api/v1/portal/team/" + encodeURIComponent(String(memberId)),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
}

export async function removeTeamMember(
  accessToken: string,
  memberId: number
): Promise<TeamMutationResult> {
  return teamMutation(
    accessToken,
    "api/v1/portal/team/" + encodeURIComponent(String(memberId)),
    { method: "DELETE" }
  );
}

export async function assignConversation(
  accessToken: string,
  conversationId: number,
  assigneeEmail: string | null
): Promise<AssignConversationResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/assign",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_email: assigneeEmail }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).error
        : null;
    const errorCode =
      code !== null && typeof code === "object"
        ? (code as Record<string, unknown>).code
        : null;
    if (errorCode === "assignee_not_found") return { kind: "assignee_not_found" };
    return { kind: "not_found" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "unavailable" };
  }
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
  };
}

export async function listConversationNotes(
  accessToken: string,
  conversationId: number
): Promise<{ notes: NoteEntry[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/notes"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawNotes = (payload as Record<string, unknown>).notes;
  if (!Array.isArray(rawNotes)) return { notes: [] };
  const notes: NoteEntry[] = [];
  for (const raw of rawNotes) {
    const note = normalizeNoteEntry(raw);
    if (note) notes.push(note);
  }
  return { notes };
}

export async function addConversationNote(
  accessToken: string,
  conversationId: number,
  body: string
): Promise<NoteAddResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "ok", note: null };
  }
  const note = normalizeNoteEntry((payload as Record<string, unknown>).note);
  return { kind: "ok", note };
}

export type ConversationStatusResult =`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "team + notes table constants",
        from: `MSGS_TABLE = os.environ.get("OF_MSGS_TABLE", "portal_messages")`,
        to: `MSGS_TABLE = os.environ.get("OF_MSGS_TABLE", "portal_messages")
TEAM_TABLE = os.environ.get("OF_TEAM_TABLE", "portal_team_members")
NOTES_TABLE = os.environ.get("OF_NOTES_TABLE", "portal_conversation_notes")`,
      },
      {
        name: "lazy DDL: assigned_to + team members + notes",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_orders_client
  ON portal_orders (client_id, updated_at DESC);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_orders_client
  ON portal_orders (client_id, updated_at DESC);
ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS assigned_to TEXT;
CREATE TABLE IF NOT EXISTS portal_team_members (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_team_email UNIQUE (client_id, email)
);
CREATE INDEX IF NOT EXISTS idx_portal_team_client
  ON portal_team_members (client_id, status);
CREATE TABLE IF NOT EXISTS portal_conversation_notes (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  author_email TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_conv_notes
  ON portal_conversation_notes (conversation_id, id DESC);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "list SELECT carries assignment fields",
        from: `        " c.lead_score, c.lead_temp,"`,
        to: `        " c.lead_score, c.lead_temp, c.assigned_to, tm.name AS assignee_name,"`,
      },
      {
        name: "list SELECT joins team for assignee name",
        from: `        " ) AS unread FROM "
        + portal_db._q(portal_db.CONV_TABLE) + " c"
        " WHERE c.client_id = %s"`,
        to: `        " ) AS unread FROM "
        + portal_db._q(portal_db.CONV_TABLE) + " c"
        " LEFT JOIN " + portal_db._q(portal_db.TEAM_TABLE) + " tm"
        " ON tm.client_id = c.client_id AND tm.email = c.assigned_to"
        " WHERE c.client_id = %s"`,
      },
      {
        name: "detail SELECT carries assignment fields",
        from: `                    " lead_score, lead_temp FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",`,
        to: `                    " c.lead_score, c.lead_temp, c.assigned_to,"
                    " tm.name AS assignee_name FROM "
                    + portal_db._q(portal_db.CONV_TABLE) + " c"
                    " LEFT JOIN " + portal_db._q(portal_db.TEAM_TABLE) + " tm"
                    " ON tm.client_id = c.client_id AND tm.email = c.assigned_to"
                    " WHERE c.id = %s AND c.client_id = %s LIMIT 1",`,
      },
      {
        name: "public payload exposes assignee",
        from: `        "lead_score": int(row.get("lead_score") or 0),
        "lead_temp": row.get("lead_temp") or "cold",
    }`,
        to: `        "lead_score": int(row.get("lead_score") or 0),
        "lead_temp": row.get("lead_temp") or "cold",
        "assigned_to": row.get("assigned_to"),
        "assignee_name": row.get("assignee_name"),
    }`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import portal_team blueprint",
        from: `from portal_revenue import bp as portal_revenue_bp  # noqa: E402`,
        to: `from portal_revenue import bp as portal_revenue_bp  # noqa: E402
from portal_team import bp as portal_team_bp  # noqa: E402`,
      },
      {
        name: "register portal_team blueprint",
        from: `aux_app.register_blueprint(portal_revenue_bp)`,
        to: `aux_app.register_blueprint(portal_revenue_bp)
aux_app.register_blueprint(portal_team_bp)`,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "ConversationSummary gains assignment fields",
        from: `  leadScore: number;
  leadTemp: string;
}`,
        to: `  leadScore: number;
  leadTemp: string;
  assignedTo: string | null;
  assigneeName: string | null;
}`,
      },
      {
        name: "normalizer maps assignment fields",
        from: `    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
  };
}`,
        to: `    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
  };
}`,
      },
      {
        name: "team + notes client functions",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_TEAM_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "list item type gains assigneeName",
        from: `  lastIntent: string | null;
  leadTemp: string;
}`,
        to: `  lastIntent: string | null;
  leadTemp: string;
  assigneeName: string | null;
}`,
      },
      {
        name: "chip row renders for assigned chats too",
        from: `                {((item.lastIntent && item.lastIntent !== "general") ||
                  item.leadTemp === "hot") && (`,
        to: `                {((item.lastIntent && item.lastIntent !== "general") ||
                  item.leadTemp === "hot" ||
                  Boolean(item.assigneeName)) && (`,
      },
      {
        name: "violet assignee chip",
        from: `                    {item.leadTemp === "hot" && (
                      <span className="inline-block rounded-md border border-orange-400/25 bg-orange-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-orange-300">
                        Hot lead
                      </span>
                    )}
                  </div>`,
        to: `                    {item.leadTemp === "hot" && (
                      <span className="inline-block rounded-md border border-orange-400/25 bg-orange-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-orange-300">
                        Hot lead
                      </span>
                    )}
                    {item.assigneeName && (
                      <span className="inline-block rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300">
                        {item.assigneeName}
                      </span>
                    )}
                  </div>`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "import team card",
        from: `import CodCard from "./CodCard";`,
        to: `import CodCard from "./CodCard";
import TeamCard from "./TeamCard";`,
      },
      {
        name: "thread conversation type gains assignment",
        from: `interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
}`,
        to: `interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
  assignedTo: string | null;
}`,
      },
      {
        name: "render team card above thread",
        from: `      {!expired && !notFound && <CodCard conversationId={Number(id)} />}
`,
        to: `      {!expired && !notFound && <CodCard conversationId={Number(id)} />}
      {!expired && !notFound && (
        <TeamCard
          conversationId={Number(id)}
          initialAssignedTo={conversation?.assignedTo ?? null}
        />
      )}
`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "nav: Team item before Settings",
        custom: {
          alreadyMarker: '"/dashboard/team"',
          build: (text) => {
            const labelIndex = text.indexOf('label: "Settings"');
            if (labelIndex === -1) return null;
            const braceIndex = text.lastIndexOf("{", labelIndex);
            if (braceIndex === -1) return null;
            const item =
              '{ label: "Team", href: "/dashboard/team", icon: "⚑", enabled: true },\n  ';
            return text.slice(0, braceIndex) + item + text.slice(braceIndex);
          },
        },
      },
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

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
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
    if (swap.custom) {
      if (text.includes(swap.custom.alreadyMarker)) {
        alreadyTotal++;
        continue;
      }
      const next = swap.custom.build(text);
      if (next === null || next === text) {
        warnTotal++;
        console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
        continue;
      }
      text = next;
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
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

  const backup = target.file + ".pre_team.bak";
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

// New files (written only when missing).
const NEW_FILES = [
  [MODULE_PATH, PY_MODULE],
  [BFF_TEAM_PATH, BFF_TEAM_FILE],
  [BFF_TEAM_ID_PATH, BFF_TEAM_ID_FILE],
  [BFF_ASSIGN_PATH, BFF_ASSIGN_FILE],
  [BFF_NOTES_PATH, BFF_NOTES_FILE],
  [TEAM_PAGE_PATH, TEAM_PAGE_FILE],
  [TEAM_CARD_PATH, TEAM_CARD_FILE],
];
for (const [newPath, newContent] of NEW_FILES) {
  if (fs.existsSync(newPath)) {
    console.log("= " + newPath + " (already present)");
  } else {
    writeFileEnsuringDir(newPath, newContent);
    appliedTotal++;
    console.log("+ " + newPath);
  }
}
if (fs.existsSync(MODULE_PATH)) {
  if (!compilePython(MODULE_PATH)) {
    console.log("FAIL (new module compile failed): " + MODULE_PATH);
    warnTotal++;
  }
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
