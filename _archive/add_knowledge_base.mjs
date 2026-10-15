// add_knowledge_base.mjs — Phase 4: Knowledge Base v0 (zero AI cost).
//
// Businesses store answers (title, category, keywords, content) as knowledge
// base entries on a new portal page. When an inbound WhatsApp message
// classifies as a general informational intent (general, shipping,
// order_tracking, appointment) and a keyword matches an active entry, the
// Control Plane queues a regular send_message command — the laptop connector
// delivers it through the EXISTING command polling, so the bridge needs NO
// changes and NO restart. Complaints, refund requests and human-handoff
// messages are never auto-answered. Matching is deterministic keyword
// scoring (multi-word phrases supported, EN + Roman Urdu), zero AI cost.
//
// Backend : portal_kb.py (CRUD + matcher + ingest hook), portal_db lazy DDL,
//           app.py blueprint, connector_api ingest hook, migration 012 record.
// Website : portal.ts helpers, BFF routes (kb + kb/[id]), knowledge-base page
//           + client, DashSidebar nav link.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_knowledge_base.mjs
//
// Requires Phase 3 (add_followup_agent.mjs) to be applied first — the ingest
// hook and lazy-DDL anchors come from it.
//
// CRLF-tolerant, idempotent, backups: *.pre_kb.bak

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_kb.py";
const MIGRATION_PATH = "OmniFlow-Control-Plane/migrations/012_knowledge_base.sql";
const BFF_KB_PATH = "Omniflow/app/api/omniflow/portal/kb/route.ts";
const BFF_KB_ID_PATH = "Omniflow/app/api/omniflow/portal/kb/[id]/route.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/knowledge-base/page.tsx";
const CLIENT_PATH =
  "Omniflow/app/dashboard/(portal)/knowledge-base/KnowledgeBaseClient.tsx";

const MODULE_FILE = `"""Portal knowledge base (customer Bearer + ingest-time auto-reply).

Businesses store answers (title, category, keywords, content) as knowledge
base entries. When an inbound WhatsApp message classifies as a general
informational intent (general, shipping, order_tracking, appointment) and a
keyword matches an active entry, the Control Plane queues a regular
send_message command; the laptop connector delivers it through the existing
command polling. Complaints, refund requests and human-handoff messages are
never auto-answered. Matching is deterministic keyword scoring: zero AI cost.
"""

import json
import logging
import re
from typing import Any, Dict

from flask import Blueprint, jsonify, request

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db


logger = logging.getLogger("omniflow.portal-knowledge-base")

bp = Blueprint("portal_kb", __name__, url_prefix="/api/v1")

KB_SETTINGS_TABLE = "portal_kb_settings"
KB_TABLE = "portal_kb_entries"

# Intents eligible for instant knowledge-base answers. Sensitive intents
# (human_request, complaint, refund_return) and the sales intents owned by
# the follow-up agent are deliberately excluded.
KB_AUTO_INTENTS = ("general", "shipping", "order_tracking", "appointment")

MIN_KEYWORD_SCORE = 3  # one keyword hit = 3 points
AUTO_REPLY_COOLDOWN_SECONDS = 120
MAX_LIST_ENTRIES = 200


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


def _normalize_text(value) -> str:
    cleaned = re.sub(r"[^\\w\\s]", " ", str(value or "").lower())
    return re.sub(r"\\s+", " ", cleaned).strip()


def _entry_json(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "title": str(row.get("title") or ""),
        "category": str(row.get("category") or "general"),
        "keywords": str(row.get("keywords") or ""),
        "content": str(row.get("content") or ""),
        "is_active": row.get("is_active") is True,
        "usage_count": int(row.get("usage_count") or 0),
    }


def _clean_entry_payload(raw):
    """Validate a knowledge-base entry payload. Returns (fields, error)."""
    if not isinstance(raw, dict):
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "entry object is required."}}), 400)
    title = str(raw.get("title") or "").strip()
    content = str(raw.get("content") or "").strip()
    keywords = str(raw.get("keywords") or "").strip()
    category = str(raw.get("category") or "").strip() or "general"
    is_active_raw = raw.get("is_active")
    if is_active_raw is None:
        is_active = True
    else:
        is_active = is_active_raw is True or str(is_active_raw).lower() == "true"
    if not title or len(title) > 200:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Title is required (max 200 characters)."}}), 400)
    if not content or len(content) > 4000:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Answer is required (max 4000 characters)."}}), 400)
    if len(keywords) > 600:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Keywords must be 600 characters or fewer."}}), 400)
    if len(category) > 60:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Category must be 60 characters or fewer."}}), 400)
    return {
        "title": title,
        "content": content,
        "keywords": keywords,
        "category": category,
        "is_active": is_active,
    }, None


def match_knowledge_base(cur, client_id, message_text):
    """Return the best-scoring active entry whose keywords hit the message.

    Single tokens score 3 when the normalized message contains the token;
    multi-word keywords score 3 when the phrase appears in the normalized
    text. Requires MIN_KEYWORD_SCORE (at least one keyword hit).
    """
    normalized = _normalize_text(message_text)
    if not normalized:
        return None
    tokens = set(normalized.split(" "))
    cur.execute(
        "SELECT id, title, content, keywords FROM " + portal_db._q(KB_TABLE) +
        " WHERE client_id = %s AND is_active IS TRUE LIMIT %s",
        (client_id, MAX_LIST_ENTRIES),
    )
    best = None
    best_score = 0
    for row in portal_db.rows(cur):
        score = 0
        for chunk in str(row.get("keywords") or "").split(","):
            keyword = _normalize_text(chunk)
            if not keyword:
                continue
            if " " in keyword:
                if keyword in normalized:
                    score += 3
            elif keyword in tokens:
                score += 3
        if score > best_score:
            best_score = score
            best = row
    if best is None or best_score < MIN_KEYWORD_SCORE:
        return None
    return best


def maybe_auto_reply(client_id, conversation_id, contact_id, contact_name,
                     message_text, intent, conn):
    """Queue an instant knowledge-base answer inside the ingest transaction.

    Fires only for KB_AUTO_INTENTS when auto-reply is enabled, no outbound
    message was sent to this conversation in the last
    AUTO_REPLY_COOLDOWN_SECONDS, and an active entry keyword-matches the
    message. Never raises into the caller: wrap in try/except there.
    """
    if intent not in KB_AUTO_INTENTS:
        return
    external_user_id = str(contact_id or "").strip()
    if not external_user_id:
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT auto_reply FROM " + portal_db._q(KB_SETTINGS_TABLE) +
            " WHERE client_id = %s LIMIT 1",
            (client_id,),
        )
        settings_rows = portal_db.rows(cur)
        if not settings_rows or settings_rows[0].get("auto_reply") is not True:
            return
        cur.execute(
            "SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " WHERE conversation_id = %s AND direction = 'out'"
            " AND created_at > NOW() - make_interval(secs => %s)"
            " LIMIT 1",
            (conversation_id, AUTO_REPLY_COOLDOWN_SECONDS),
        )
        if portal_db.rows(cur):
            return  # we just answered this conversation — stay quiet
        entry = match_knowledge_base(cur, client_id, message_text)
        if entry is None:
            return
        display_name = str(contact_name or "").strip()
        first_name = display_name.split(" ")[0] if display_name else "there"
        rendered = str(entry.get("content") or "").replace(
            "{name}", first_name
        ).strip()
        if not rendered:
            return
        payload = {
            "external_user_id": external_user_id,
            "body": rendered[:1000],
            "conversation_id": conversation_id,
            "source": "knowledge_base",
        }
        if display_name:
            payload["target_display_name"] = display_name
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
            " (client_id, channel, action, payload, status, requested_by,"
            " created_at, updated_at) "
            "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
            " 'pending', NULL, NOW(), NOW()) "
            "RETURNING id",
            (client_id, json.dumps(payload)),
        )
        cur.execute(
            "UPDATE " + portal_db._q(KB_TABLE) +
            " SET usage_count = usage_count + 1 WHERE id = %s",
            (entry.get("id"),),
        )
    logger.info(
        "knowledge base auto-reply queued entry=%s conversation=%s client=%s",
        entry.get("id"),
        conversation_id,
        client_id,
    )


@bp.get("/portal/kb")
def get_knowledge_base():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(KB_SETTINGS_TABLE) +
                    " (client_id) VALUES (%s)"
                    " ON CONFLICT (client_id) DO NOTHING",
                    (principal["client_id"],),
                )
                cur.execute(
                    "SELECT auto_reply FROM " + portal_db._q(KB_SETTINGS_TABLE) +
                    " WHERE client_id = %s LIMIT 1",
                    (principal["client_id"],),
                )
                settings_rows = portal_db.rows(cur)
                cur.execute(
                    "SELECT id, title, category, keywords, content,"
                    " is_active, usage_count FROM " + portal_db._q(KB_TABLE) +
                    " WHERE client_id = %s"
                    " ORDER BY updated_at DESC, id DESC LIMIT %s",
                    (principal["client_id"], MAX_LIST_ENTRIES),
                )
                entry_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base")[0]), 503
    settings_row = settings_rows[0] if settings_rows else {}
    return jsonify({
        "settings": {"auto_reply": settings_row.get("auto_reply") is True},
        "entries": [_entry_json(row) for row in entry_rows],
    }), 200


@bp.post("/portal/kb")
def create_kb_entry():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    fields, entry_error = _clean_entry_payload(payload.get("entry"))
    if entry_error is not None:
        return entry_error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(KB_TABLE) +
                    " (client_id, title, category, keywords, content, is_active)"
                    " VALUES (%s, %s, %s, %s, %s, %s)"
                    " RETURNING id, title, category, keywords, content,"
                    " is_active, usage_count",
                    (principal["client_id"], fields["title"], fields["category"],
                     fields["keywords"], fields["content"], fields["is_active"]),
                )
                created = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base create")[0]), 503
    return jsonify({
        "ok": True,
        "entry": _entry_json(created[0] if created else {}),
    }), 200


@bp.put("/portal/kb")
def save_kb_settings():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    raw = payload.get("settings")
    auto_reply = raw.get("auto_reply") if isinstance(raw, dict) else None
    if not isinstance(auto_reply, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "auto_reply must be true or false."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(KB_SETTINGS_TABLE) +
                    " (client_id, auto_reply, updated_at)"
                    " VALUES (%s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " auto_reply = EXCLUDED.auto_reply, updated_at = NOW()",
                    (principal["client_id"], auto_reply),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base settings")[0]), 503
    return jsonify({"ok": True, "settings": {"auto_reply": auto_reply}}), 200


@bp.put("/portal/kb/<int:entry_id>")
def update_kb_entry(entry_id):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    fields, entry_error = _clean_entry_payload(payload.get("entry"))
    if entry_error is not None:
        return entry_error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(KB_TABLE) +
                    " SET title = %s, category = %s, keywords = %s,"
                    " content = %s, is_active = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, title, category, keywords, content,"
                    " is_active, usage_count",
                    (fields["title"], fields["category"], fields["keywords"],
                     fields["content"], fields["is_active"],
                     entry_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base update")[0]), 503
    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Knowledge base entry not found."}}), 404
    return jsonify({"ok": True, "entry": _entry_json(updated[0])}), 200


@bp.delete("/portal/kb/<int:entry_id>")
def delete_kb_entry(entry_id):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(KB_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (entry_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base delete")[0]), 503
    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Knowledge base entry not found."}}), 404
    return jsonify({"ok": True}), 200
`;

const MIGRATION_FILE = `-- 012: knowledge base (settings + entries)
-- Applied automatically by portal_db.ensure_tables(); kept here as the
-- canonical migration record (001-012).
CREATE TABLE IF NOT EXISTS portal_kb_settings (
  client_id BIGINT PRIMARY KEY,
  auto_reply BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_kb_entries (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  keywords TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  usage_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_entries
  ON portal_kb_entries (client_id, is_active, updated_at DESC);
`;

const BFF_KB_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createKbEntry,
  getKnowledgeBase,
  requirePortalAccessToken,
  saveKbSettings,
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
    const data = await getKnowledgeBase(accessToken);
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

function parseEntryInput(payload: {
  entry?: {
    title?: unknown;
    category?: unknown;
    keywords?: unknown;
    content?: unknown;
    isActive?: unknown;
  };
} | null):
  | { kind: "ok"; entry: { title: string; category: string; keywords: string; content: string; isActive: boolean } }
  | { kind: "error"; message: string } {
  const input = payload?.entry;
  if (!input) {
    return { kind: "error", message: "entry object is required." };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const keywords = typeof input.keywords === "string" ? input.keywords.trim() : "";
  const category =
    typeof input.category === "string" && input.category.trim()
      ? input.category.trim()
      : "general";
  const isActive = input.isActive !== false;
  if (!title || title.length > 200) {
    return { kind: "error", message: "Title is required (max 200 characters)." };
  }
  if (!content || content.length > 4000) {
    return { kind: "error", message: "Answer is required (max 4000 characters)." };
  }
  if (keywords.length > 600) {
    return { kind: "error", message: "Keywords must be 600 characters or fewer." };
  }
  if (category.length > 60) {
    return { kind: "error", message: "Category must be 60 characters or fewer." };
  }
  return { kind: "ok", entry: { title, category, keywords, content, isActive } };
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as Parameters<
    typeof parseEntryInput
  >[0];
  const parsed = parseEntryInput(payload);
  if (parsed.kind === "error") {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const ok = await createKbEntry(accessToken, parsed.entry);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
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

export async function PUT(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    settings?: { autoReply?: unknown };
  } | null;
  const autoReply = payload?.settings?.autoReply;
  if (typeof autoReply !== "boolean") {
    return safeJson(
      { error: { code: "bad_request", message: "autoReply must be true or false." } },
      400
    );
  }

  try {
    const ok = await saveKbSettings(accessToken, { autoReply });
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, settings: { autoReply } }, 200);
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

const BFF_KB_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteKbEntry,
  requirePortalAccessToken,
  updateKbEntry,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

function parseEntryInput(payload: {
  entry?: {
    title?: unknown;
    category?: unknown;
    keywords?: unknown;
    content?: unknown;
    isActive?: unknown;
  };
} | null):
  | { kind: "ok"; entry: { title: string; category: string; keywords: string; content: string; isActive: boolean } }
  | { kind: "error"; message: string } {
  const input = payload?.entry;
  if (!input) {
    return { kind: "error", message: "entry object is required." };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const keywords = typeof input.keywords === "string" ? input.keywords.trim() : "";
  const category =
    typeof input.category === "string" && input.category.trim()
      ? input.category.trim()
      : "general";
  const isActive = input.isActive !== false;
  if (!title || title.length > 200) {
    return { kind: "error", message: "Title is required (max 200 characters)." };
  }
  if (!content || content.length > 4000) {
    return { kind: "error", message: "Answer is required (max 4000 characters)." };
  }
  if (keywords.length > 600) {
    return { kind: "error", message: "Keywords must be 600 characters or fewer." };
  }
  if (category.length > 60) {
    return { kind: "error", message: "Category must be 60 characters or fewer." };
  }
  return { kind: "ok", entry: { title, category, keywords, content, isActive } };
}

export async function PUT(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as Parameters<
    typeof parseEntryInput
  >[0];
  const parsed = parseEntryInput(payload);
  if (parsed.kind === "error") {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const ok = await updateKbEntry(accessToken, entryId, parsed.entry);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
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

export async function DELETE(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid entry id." } },
      400
    );
  }

  try {
    const ok = await deleteKbEntry(accessToken, entryId);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
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

const PAGE_FILE = `import { getKnowledgeBase } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import KnowledgeBaseClient from "./KnowledgeBaseClient";


export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const { accessToken } = await readSessionCookies();
  const data = accessToken ? await getKnowledgeBase(accessToken) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Knowledge base
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Ready answers your assistant sends instantly when customers ask
          general questions. Add entries with trigger keywords; sensitive
          conversations are never auto-answered.
        </p>
      </div>

      {data === null ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
          <p className="text-xs leading-relaxed text-slate-500">
            The knowledge base is rolling out on the server — try again
            shortly after the deploy finishes.
          </p>
        </div>
      ) : (
        <KnowledgeBaseClient initial={data} />
      )}
    </div>
  );
}
`;

const CLIENT_FILE = `"use client";

import { useCallback, useMemo, useState } from "react";
import type { KnowledgeBaseData } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

const ghostBtn =
  "rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50";

const chipClass =
  "rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500";

interface KbFormState {
  id: number | null;
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
}

const EMPTY_FORM: KbFormState = {
  id: null,
  title: "",
  category: "general",
  keywords: "",
  content: "",
  isActive: true,
};

export default function KnowledgeBaseClient({
  initial,
}: {
  initial: KnowledgeBaseData;
}) {
  const [autoReply, setAutoReply] = useState(initial.settings.autoReply);
  const [entries, setEntries] = useState(initial.entries);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<KbFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as
        | (KnowledgeBaseData & { error?: unknown })
        | null;
      if (payload && Array.isArray(payload.entries)) {
        setEntries(payload.entries);
        setAutoReply(payload.settings?.autoReply === true);
      }
    } catch {
      // Transient network issue — the next action retries.
    }
  }, []);

  async function toggleAutoReply(next: boolean) {
    if (busy) return;
    setAutoReply(next);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ settings: { autoReply: next } }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: next
            ? "Automatic replies are on."
            : "Automatic replies are off.",
        });
      } else {
        setAutoReply(!next);
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setAutoReply(!next);
      setMessage({ kind: "error", text: "Network error — try again." });
    }
  }

  async function saveForm() {
    if (busy || !form) return;
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      setMessage({ kind: "error", text: "Title and answer are required." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        form.id === null
          ? "/api/omniflow/portal/kb"
          : "/api/omniflow/portal/kb/" + String(form.id),
        {
          method: form.id === null ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            entry: {
              title,
              category: form.category.trim() || "general",
              keywords: form.keywords.trim(),
              content,
              isActive: form.isActive,
            },
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: form.id === null ? "Entry added." : "Entry updated.",
        });
        setForm(null);
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(entryId: number) {
    if (busy) return;
    if (
      !window.confirm(
        "Delete this entry? Customers will no longer receive this answer."
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/kb/" + String(entryId),
        {
          method: "DELETE",
          credentials: "same-origin",
        }
      );
      if (response.ok) {
        setMessage({ kind: "ok", text: "Entry deleted." });
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: "Could not delete. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.title.toLowerCase().includes(query) ||
        entry.category.toLowerCase().includes(query) ||
        entry.keywords.toLowerCase().includes(query) ||
        entry.content.toLowerCase().includes(query)
    );
  }, [entries, search]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Automatic replies
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              When a customer message matches an entry keyword, the assistant
              sends that answer instantly on WhatsApp. Fires for general,
              shipping, order-tracking and appointment questions. Complaints,
              refund requests and requests for a human are never
              auto-answered.
            </p>
          </div>
          <button
            type="button"
            onClick={() => toggleAutoReply(!autoReply)}
            aria-pressed={autoReply}
            className={"relative h-6 w-11 shrink-0 rounded-full transition-colors " +
              (autoReply ? "bg-cyan-400" : "bg-white/[0.1]")}
          >
            <span
              className={"absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all " +
                (autoReply ? "left-[22px]" : "left-0.5")}
            />
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {autoReply
            ? "Automatic replies are ON — matching entries are sent instantly."
            : "Automatic replies are OFF — entries are a reference library only until you switch them on."}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search entries..."
          className={inputClass + " sm:flex-1"}
        />
        <button
          type="button"
          onClick={() => {
            setForm({ ...EMPTY_FORM });
            setMessage(null);
          }}
          className={primaryBtn}
        >
          Add entry
        </button>
      </div>

      {message && (
        <div
          className={
            "rounded-xl border px-4 py-3 text-xs leading-relaxed " +
            (message.kind === "ok"
              ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200/90"
              : "border-red-400/20 bg-red-400/[0.05] text-red-200/90")
          }
        >
          {message.text}
        </div>
      )}

      {form && (
        <div className="rounded-2xl border border-cyan-400/15 bg-white/[0.02] p-6">
          <h3 className="text-sm font-semibold text-white">
            {form.id === null ? "New entry" : "Edit entry"}
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="kbTitle" className={labelClass}>
                Question title
              </label>
              <input
                id="kbTitle"
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Delivery time"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="kbCategory" className={labelClass}>
                Category
              </label>
              <input
                id="kbCategory"
                type="text"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="general"
                className={inputClass}
              />
            </div>
          </div>
          <div className="mt-4">
            <label htmlFor="kbKeywords" className={labelClass}>
              Trigger keywords
            </label>
            <input
              id="kbKeywords"
              type="text"
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              placeholder="delivery, delivery time, kitne din"
              className={inputClass}
            />
            <p className="mt-1.5 text-[11px] text-slate-600">
              Comma separated. A customer message containing any keyword can
              receive this answer automatically.
            </p>
          </div>
          <div className="mt-4">
            <label htmlFor="kbContent" className={labelClass}>
              Answer
            </label>
            <textarea
              id="kbContent"
              rows={5}
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="Hi {name}! We deliver in 2-3 working days across Karachi..."
              className={inputClass}
            />
            <p className="mt-1.5 text-[11px] text-slate-600">
              {"{name}"} becomes the customer&apos;s first name.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) =>
                  setForm({ ...form, isActive: e.target.checked })
                }
                className="h-4 w-4 rounded border-white/20 bg-white/[0.03]"
              />
              Active
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setForm(null)}
                className={ghostBtn}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => saveForm()}
                disabled={busy}
                className={primaryBtn}
              >
                {busy ? "Saving..." : "Save entry"}
              </button>
            </div>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-8 text-center">
          <p className="text-sm text-slate-400">No entries yet</p>
          <p className="mt-1 text-xs text-slate-600">
            Add your first answer — delivery times, prices, policies, hours.
          </p>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-8 text-center">
          <p className="text-xs text-slate-500">No entries match your search.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-white">
                      {entry.title}
                    </h3>
                    <span className={chipClass}>{entry.category}</span>
                    {!entry.isActive && (
                      <span className="rounded-md border border-amber-400/20 bg-amber-400/[0.05] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-300/80">
                        Hidden
                      </span>
                    )}
                  </div>
                  {entry.keywords && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Keywords: {entry.keywords}
                    </p>
                  )}
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
                    {entry.content}
                  </p>
                  <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-600">
                    Sent {entry.usageCount}{" "}
                    {entry.usageCount === 1 ? "time" : "times"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setForm({
                        id: entry.id,
                        title: entry.title,
                        category: entry.category,
                        keywords: entry.keywords,
                        content: entry.content,
                        isActive: entry.isActive,
                      });
                      setMessage(null);
                    }}
                    className={ghostBtn}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.id)}
                    disabled={busy}
                    className="rounded-xl border border-red-400/15 bg-red-400/[0.04] px-4 py-2 text-xs font-medium text-red-300/80 transition-colors duration-300 hover:bg-red-400/[0.09] disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
`;

const TARGETS = [
  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "lazy knowledge-base tables",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_followups_due
  ON portal_followups (client_id, stage, next_due_at);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_followups_due
  ON portal_followups (client_id, stage, next_due_at);
CREATE TABLE IF NOT EXISTS portal_kb_settings (
  client_id BIGINT PRIMARY KEY,
  auto_reply BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_kb_entries (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  keywords TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  usage_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_entries
  ON portal_kb_entries (client_id, is_active, updated_at DESC);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import knowledge-base blueprint",
        from: `from portal_followups import bp as portal_followups_bp  # noqa: E402`,
        to: `from portal_followups import bp as portal_followups_bp  # noqa: E402
from portal_kb import bp as portal_kb_bp  # noqa: E402`,
      },
      {
        name: "register knowledge-base blueprint",
        from: `aux_app.register_blueprint(portal_followups_bp)`,
        to: `aux_app.register_blueprint(portal_followups_bp)
aux_app.register_blueprint(portal_kb_bp)`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      {
        name: "import knowledge-base helper",
        from: `import portal_followups`,
        to: `import portal_followups
import portal_kb`,
      },
      {
        name: "knowledge-base auto-reply inside ingest",
        from: `                    except Exception:
                        pass
                    inserted += 1`,
        to: `                    except Exception:
                        pass
                    try:
                        portal_kb.maybe_auto_reply(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["body"],
                            item["intent"],
                            conn,
                        )
                    except Exception:
                        pass
                    inserted += 1`,
      },
    ],
  },
  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "knowledge-base client helpers",
        from: `export type ConversationStatusResult =`,
        to: `export interface KbEntry {
  id: number;
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  usageCount: number;
}

export interface KbEntryInput {
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
}

export interface KbSettings {
  autoReply: boolean;
}

export interface KnowledgeBaseData {
  settings: KbSettings;
  entries: KbEntry[];
}

function mapKbEntry(raw: Record<string, unknown>): KbEntry {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    title: typeof raw.title === "string" ? raw.title : "",
    category: typeof raw.category === "string" ? raw.category : "general",
    keywords: typeof raw.keywords === "string" ? raw.keywords : "",
    content: typeof raw.content === "string" ? raw.content : "",
    isActive: raw.is_active === true,
    usageCount: typeof raw.usage_count === "number" ? raw.usage_count : 0,
  };
}

export async function getKnowledgeBase(
  accessToken: string
): Promise<KnowledgeBaseData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawSettings = p.settings;
  const rawEntries = p.entries;
  if (rawSettings === null || typeof rawSettings !== "object") return null;
  const settingsRaw = rawSettings as Record<string, unknown>;
  return {
    settings: { autoReply: settingsRaw.auto_reply === true },
    entries: Array.isArray(rawEntries)
      ? rawEntries
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map(mapKbEntry)
      : [],
  };
}

export async function createKbEntry(
  accessToken: string,
  entry: KbEntryInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: {
          title: entry.title,
          category: entry.category,
          keywords: entry.keywords,
          content: entry.content,
          is_active: entry.isActive,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function updateKbEntry(
  accessToken: string,
  entryId: number,
  entry: KbEntryInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/" + entryId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: {
            title: entry.title,
            category: entry.category,
            keywords: entry.keywords,
            content: entry.content,
            is_active: entry.isActive,
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteKbEntry(
  accessToken: string,
  entryId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/" + entryId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function saveKbSettings(
  accessToken: string,
  settings: KbSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          auto_reply: settings.autoReply,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export type ConversationStatusResult =`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "sidebar knowledge-base link",
        regex: "const navItems: NavItem\\[\\] = \\[",
        flags: "",
        alreadyMarker: "/dashboard/knowledge-base",
        to: `const navItems: NavItem[] = [
  {
    label: "Knowledge base",
    href: "/dashboard/knowledge-base",
    icon: "▣",
    enabled: true,
  },`,
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
    if (swap.regex) {
      if (swap.alreadyMarker && text.includes(swap.alreadyMarker)) {
        alreadyTotal++;
        continue;
      }
      const global = new RegExp(swap.regex, (swap.flags || "") + "g");
      const hits = text.match(global);
      if (hits && hits.length === 1) {
        text = text.replace(global, swap.to);
        changed = true;
        appliedTotal++;
        fileApplied.push(swap.name);
      } else {
        warnTotal++;
        console.log(
          "  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this"
        );
      }
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

  const backup = target.file + ".pre_kb.bak";
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
  [MODULE_PATH, MODULE_FILE],
  [MIGRATION_PATH, MIGRATION_FILE],
  [BFF_KB_PATH, BFF_KB_FILE],
  [BFF_KB_ID_PATH, BFF_KB_ID_FILE],
  [PAGE_PATH, PAGE_FILE],
  [CLIENT_PATH, CLIENT_FILE],
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