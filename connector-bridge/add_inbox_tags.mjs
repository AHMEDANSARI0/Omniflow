// add_inbox_tags.mjs — Phase 12: Conversation Tags + Label Filter v0.
//
// Team inbox deepening (zero AI, no bridge changes -> NO bot restart):
// 1. Labels (tags) on conversations: add up to 6 short labels per chat from
//    the conversation thread page ("vip", "wholesale", "karachi" ...), shown
//    as colored chips on inbox rows and inside the thread.
// 2. Label filter: the conversations list gets a label chip row (with usage
//    counts) so merchants can pull up every chat carrying a label.
// 3. Labels ride along in list + detail responses and combine with the
//    existing status / intent / channel filters and search.
//
// Reuses the Phase-8 team-inbox base (assignment + internal notes already
// shipped); this adds the missing labels layer on top.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_inbox_tags.mjs
//
// Requires Phase 11 (add_widget_control.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_tags.bak
// Expected first run: 28 applied, 0 warnings (25 swaps + 3 new files).
// Expected rerun:     0 applied, 25 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_TAGS_SUMMARY_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/tags/route.ts";
const BFF_CONVERSATION_TAGS_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/[id]/tags/route.ts";
const TAGS_CARD_PATH =
  "Omniflow/app/dashboard/(portal)/conversations/[id]/TagsCard.tsx";

const BFF_TAGS_SUMMARY_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getConversationTagSummary,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await getConversationTagSummary(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ tags: data }, 200);
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

const BFF_CONVERSATION_TAGS_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  addConversationTag,
  removeConversationTag,
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
    tag?: unknown;
  } | null;
  const tag = typeof payload?.tag === "string" ? payload.tag : "";
  if (!tag.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Label text is required." } },
      400
    );
  }

  try {
    const result = await addConversationTag(accessToken, conversationId, tag);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Labels can be up to 24 characters.",
          },
        },
        400
      );
    }
    if (result.kind === "limit_reached") {
      return safeJson(
        {
          error: {
            code: "limit_reached",
            message: "Up to 6 labels per conversation.",
          },
        },
        409
      );
    }
    return safeJson({ ok: true, duplicate: result.duplicate }, 200);
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
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const tag = new URL(request.url).searchParams.get("tag") || "";
  if (!tag.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Label text is required." } },
      400
    );
  }

  try {
    const result = await removeConversationTag(accessToken, conversationId, tag);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, missing: result === "missing" }, 200);
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

const TAGS_CARD_FILE = `"use client";

import { useState } from "react";

const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 24;

function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 360;
  }
  return hash;
}

export default function TagsCard({
  conversationId,
  initialTags,
}: {
  conversationId: number;
  initialTags: string[];
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function addTag() {
    const tag = value.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${conversationId}/tags\`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ tag }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        duplicate?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setTags((current) =>
          payload.duplicate || current.some((t) => t.toLowerCase() === tag.toLowerCase())
            ? current
            : [...current, tag]
        );
        setValue("");
        setMessage(
          payload.duplicate ? "This label is already on the chat." : null
        );
      } else {
        setMessage(payload?.error?.message || "Could not add the label.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(tag: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${conversationId}/tags?tag=\${encodeURIComponent(tag)}\`,
        { method: "DELETE", credentials: "same-origin" }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
      } | null;
      if (response.ok && payload?.ok) {
        setTags((current) => current.filter((t) => t !== tag));
      } else {
        setMessage("Could not remove the label.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-white">Labels</h2>
        <span className="text-[10px] text-slate-500">
          {tags.length}/{MAX_TAGS}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
        Group chats your own way — labels show as chips in the inbox and become
        filters.
      </p>

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium"
              style={{
                borderColor: \`hsl(\${tagHue(tag)} 70% 50% / 0.35)\`,
                backgroundColor: \`hsl(\${tagHue(tag)} 70% 50% / 0.10)\`,
                color: \`hsl(\${tagHue(tag)} 80% 74%)\`,
              }}
            >
              #{tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                disabled={busy}
                aria-label={\`Remove label \${tag}\`}
                className="text-[13px] leading-none opacity-60 transition-opacity hover:opacity-100 disabled:opacity-30"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void addTag();
            }
          }}
          maxLength={MAX_TAG_LENGTH}
          placeholder={
            tags.length >= MAX_TAGS ? "Label limit reached" : "e.g. wholesale"
          }
          disabled={tags.length >= MAX_TAGS}
          className="w-full flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void addTag()}
          disabled={busy || tags.length >= MAX_TAGS || !value.trim()}
          className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
        >
          {busy ? "Working…" : "Add label"}
        </button>
      </div>

      {message && <p className="mt-2 text-xs text-slate-400">{message}</p>}
    </div>
  );
}
`;

const PORTAL_TS_TAGS_SECTION = `// ---------------------------------------------------------------------------
// Conversation tags (labels)
// ---------------------------------------------------------------------------

export interface ConversationTagSummary {
  tag: string;
  count: number;
}

export async function getConversationTagSummary(
  accessToken: string
): Promise<ConversationTagSummary[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/tags/summary"
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
  const rows = (payload as Record<string, unknown>).tags;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object"
    )
    .map((row) => ({
      tag: typeof row.tag === "string" ? row.tag : "",
      count: typeof row.count === "number" ? row.count : 0,
    }))
    .filter((row) => row.tag !== "");
}

export type ConversationTagWriteResult =
  | { kind: "ok"; duplicate: boolean }
  | { kind: "invalid" }
  | { kind: "limit_reached" };

export async function addConversationTag(
  accessToken: string,
  conversationId: number,
  tag: string
): Promise<ConversationTagWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/tags",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) return { kind: "limit_reached" };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  const duplicate =
    payload !== null &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).duplicate === true;
  return { kind: "ok", duplicate };
}

export async function removeConversationTag(
  accessToken: string,
  conversationId: number,
  tag: string
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        conversationId +
        "/tags?tag=" +
        encodeURIComponent(tag),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

export type ConversationStatusResult =`;

const CP_TAGS_APPEND = `


# ---------------------------------------------------------------------------
# Conversation tags (labels) — organize and filter the shared inbox
# ---------------------------------------------------------------------------

@bp.get("/conversations/tags/summary")
def conversation_tags_summary():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT tag, COUNT(*) AS uses FROM "
                    + portal_db._q(portal_db.CONV_TAGS_TABLE) +
                    " WHERE client_id = %s GROUP BY tag"
                    " ORDER BY uses DESC, tag LIMIT %s",
                    (principal["client_id"], MAX_TAG_SUMMARY),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "tag summary")[0]), 503
    return jsonify({"tags": [
        {"tag": str(row.get("tag") or ""), "count": int(row.get("uses") or 0)}
        for row in rows
    ]}), 200


@bp.post("/conversations/<int:conversation_id>/tags")
def add_conversation_tag(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    tag = _clean_tag(payload.get("tag"))
    if not tag:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Label text is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                cur.execute(
                    "SELECT id, tag FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
                    " WHERE client_id = %s AND conversation_id = %s ORDER BY id",
                    (principal["client_id"], conversation_id),
                )
                existing = portal_db.rows(cur)
                if any(str(row.get("tag") or "").lower() == tag.lower()
                       for row in existing):
                    return jsonify({"ok": True, "duplicate": True, "tag": tag}), 200
                if len(existing) >= MAX_TAGS_PER_CONVERSATION:
                    return jsonify({"error": {"code": "limit_reached",
                                              "message": "Up to 6 labels per conversation."}}), 409
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
                    " (client_id, conversation_id, tag, created_at)"
                    " VALUES (%s, %s, %s, NOW()) RETURNING id",
                    (principal["client_id"], conversation_id, tag),
                )
                inserted = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "tag.added",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    ("Label added: " + tag)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "label add")[0]), 503
    return jsonify({"ok": True, "duplicate": False, "tag": tag,
                    "id": inserted[0].get("id") if inserted else None}), 200


@bp.delete("/conversations/<int:conversation_id>/tags")
def remove_conversation_tag(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    tag = _clean_tag(request.args.get("tag"))
    if not tag:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Label text is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
                    " WHERE conversation_id = %s AND client_id = %s"
                    " AND LOWER(tag) = LOWER(%s) RETURNING id, tag",
                    (conversation_id, principal["client_id"], tag),
                )
                deleted = portal_db.rows(cur)
                if not deleted:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Label not found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "tag.removed",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    ("Label removed: " + str(deleted[0].get("tag") or ""))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "label remove")[0]), 503
    return jsonify({"ok": True}), 200
`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "conversation tags table constant",
        from: `WIDGET_TABLE = os.environ.get("OF_WIDGET_TABLE", "portal_widget_settings")`,
        to: `WIDGET_TABLE = os.environ.get("OF_WIDGET_TABLE", "portal_widget_settings")
CONV_TAGS_TABLE = os.environ.get("OF_CONVTAGS_TABLE", "portal_conversation_tags")`,
      },
      {
        name: "conversation tags DDL",
        from: `CREATE TABLE IF NOT EXISTS portal_widget_settings (
  id INT PRIMARY KEY,
  client_id BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  business_name TEXT NOT NULL DEFAULT '',
  welcome_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""`,
        to: `CREATE TABLE IF NOT EXISTS portal_widget_settings (
  id INT PRIMARY KEY,
  client_id BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  business_name TEXT NOT NULL DEFAULT '',
  welcome_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_conversation_tags (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_conv_tag UNIQUE (client_id, conversation_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_portal_conv_tags_conv
  ON portal_conversation_tags (conversation_id, id);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "re import",
        from: `import json
import logging
from datetime import datetime, timezone`,
        to: `import json
import logging
import re
from datetime import datetime, timezone`,
      },
      {
        name: "tag helpers",
        from: `@bp.get("/conversations")
def list_conversations():`,
        to: `MAX_TAGS_PER_CONVERSATION = 6
MAX_TAG_LENGTH = 24
MAX_TAG_SUMMARY = 30


def _clean_tag(value: Any) -> str:
    """Collapse whitespace and cap the length; empty string when unusable."""
    if not isinstance(value, str):
        return ""
    cleaned = re.sub(r"\\s+", " ", value).strip()
    if not cleaned:
        return ""
    return cleaned[:MAX_TAG_LENGTH]


def _tags_map(cur, client_id, conversation_ids) -> dict:
    """Return {conversation_id: [tag, ...]} for the given conversations."""
    ids = [int(cid) for cid in conversation_ids if cid is not None]
    if not ids:
        return {}
    cur.execute(
        "SELECT id, conversation_id, tag FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
        " WHERE client_id = %s AND conversation_id = ANY(%s) ORDER BY id",
        (client_id, ids),
    )
    mapping = {}
    for row in portal_db.rows(cur):
        mapping.setdefault(row.get("conversation_id"), []).append(
            str(row.get("tag") or "")
        )
    return mapping


@bp.get("/conversations")
def list_conversations():`,
      },
      {
        name: "list endpoint tag filter",
        from: `    channel_filter = (request.args.get("channel") or "").strip().lower()
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)`,
        to: `    channel_filter = (request.args.get("channel") or "").strip().lower()
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)
    tag_filter = (request.args.get("tag") or "").strip()[:MAX_TAG_LENGTH]
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)`,
      },
      {
        name: "list response carries tags",
        from: `    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversations read")[0]), 503

    return jsonify({"conversations": [_conversation_public(r) for r in found]}), 200`,
        to: `    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                tags_map = _tags_map(cur, principal["client_id"],
                                     [row.get("id") for row in found])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversations read")[0]), 503

    conversations = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        conversations.append(item)
    return jsonify({"conversations": conversations}), 200`,
      },
      {
        name: "detail fetches tags",
        from: `                msgs = portal_db.rows(cur)
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET last_read_at = NOW()"
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )`,
        to: `                msgs = portal_db.rows(cur)
                detail_tags = _tags_map(
                    cur, principal["client_id"], [conversation_id]
                ).get(conversation_id, [])
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET last_read_at = NOW()"
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )`,
      },
      {
        name: "detail response carries tags",
        from: `    return jsonify({
        "conversation": _conversation_public(found[0]),
        "messages": [_message_public(m) for m in reversed(msgs)],
    }), 200`,
        to: `    conversation_public = _conversation_public(found[0])
    conversation_public["tags"] = detail_tags
    return jsonify({
        "conversation": conversation_public,
        "messages": [_message_public(m) for m in reversed(msgs)],
    }), 200`,
      },
      {
        name: "tags endpoints appended",
        from: `    logger.info(
        "portal send_message queued id=%s conversation=%s client=%s",
        inserted[0].get("id") if inserted else "?",
        conversation_id,
        principal["client_id"],
    )
    return jsonify({"ok": True, "queued": True,
                    "command_id": inserted[0].get("id") if inserted else None}), 200`,
        to: `    logger.info(
        "portal send_message queued id=%s conversation=%s client=%s",
        inserted[0].get("id") if inserted else "?",
        conversation_id,
        principal["client_id"],
    )
    return jsonify({"ok": True, "queued": True,
                    "command_id": inserted[0].get("id") if inserted else None}), 200
` + CP_TAGS_APPEND,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "ConversationSummary tags field",
        from: `  assignedTo: string | null;
  assigneeName: string | null;
}`,
        to: `  assignedTo: string | null;
  assigneeName: string | null;
  tags: string[];
}`,
      },
      {
        name: "normalizeConversation tags",
        from: `    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
  };
}`,
        to: `    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
    tags: Array.isArray(p.tags)
      ? p.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}`,
      },
      {
        name: "listConversations tag param",
        from: `  intentFilter?: string,
  channelFilter?: string
): Promise<ConversationSummary[] | null> {`,
        to: `  intentFilter?: string,
  channelFilter?: string,
  tagFilter?: string
): Promise<ConversationSummary[] | null> {`,
      },
      {
        name: "listConversations query tag part",
        from: `  const channelPart =
    channelFilter && channelFilter !== "all"
      ? "channel=" + encodeURIComponent(channelFilter)
      : "";
  const parts = [searchPart, statusPart, intentPart, channelPart].filter(Boolean);`,
        to: `  const channelPart =
    channelFilter && channelFilter !== "all"
      ? "channel=" + encodeURIComponent(channelFilter)
      : "";
  const tagPart =
    tagFilter && tagFilter !== "all" ? "tag=" + encodeURIComponent(tagFilter) : "";
  const parts = [searchPart, statusPart, intentPart, channelPart, tagPart].filter(
    Boolean
  );`,
      },
      {
        name: "tags client functions",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_TAGS_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/conversations/route.ts",
    swaps: [
      {
        name: "BFF passes tag filter through",
        from: `    const channelParam = url.searchParams.get("channel");
    const channelFilter =
      channelParam === "whatsapp" || channelParam === "website"
        ? channelParam
        : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter
    );`,
        to: `    const channelParam = url.searchParams.get("channel");
    const channelFilter =
      channelParam === "whatsapp" || channelParam === "website"
        ? channelParam
        : undefined;
    const tagParam = url.searchParams.get("tag");
    const tagFilter = tagParam ? tagParam.trim().slice(0, 24) : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter
    );`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "local interface tags + tagHue helper",
        from: `  leadTemp: string;
  assigneeName: string | null;
}`,
        to: `  leadTemp: string;
  assigneeName: string | null;
  tags: string[];
}

function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 360;
  }
  return hash;
}`,
      },
      {
        name: "tag filter state",
        from: `  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "website">("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");`,
        to: `  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "website">("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");
  const [tagFilter, setTagFilter] = useState("all");
  const tagRef = useRef("all");
  const [tagOptions, setTagOptions] = useState<{ tag: string; count: number }[]>([]);`,
      },
      {
        name: "refresh passes tag param",
        from: `      if (channelRef.current !== "all") listParams.set("channel", channelRef.current);`,
        to: `      if (channelRef.current !== "all") listParams.set("channel", channelRef.current);
      if (tagRef.current !== "all") listParams.set("tag", tagRef.current);`,
      },
      {
        name: "tag summary load",
        from: `      if (mounted.current && payload && Array.isArray(payload.intents)) {
        setIntentCounts(payload.intents.slice(0, 6));
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, []);`,
        to: `      if (mounted.current && payload && Array.isArray(payload.intents)) {
        setIntentCounts(payload.intents.slice(0, 6));
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/conversations/tags", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status !== 200) return;
        const payload = (await response.json().catch(() => null)) as {
          tags?: { tag: string; count: number }[];
        } | null;
        if (mounted.current && payload && Array.isArray(payload.tags)) {
          setTagOptions(payload.tags.slice(0, 6));
        }
      } catch {
        // Transient network issue — the next visit retries.
      }
    })();
  }, []);`,
      },
      {
        name: "label chips row",
        from: `            {value === "all" ? "All channels" : value}
          </button>
        ))}
      </div>`,
        to: `            {value === "all" ? "All channels" : value}
          </button>
        ))}
      </div>

      {tagOptions.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {tagOptions.map((entry) => (
            <button
              key={"tag-" + entry.tag}
              onClick={() => {
                const next = tagFilter === entry.tag ? "all" : entry.tag;
                tagRef.current = next;
                setTagFilter(next);
                void refresh();
              }}
              className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
                tagFilter === entry.tag
                  ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-200"
                  : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
              }\`}
            >
              #{entry.tag} · {entry.count}
            </button>
          ))}
        </div>
      )}`,
      },
      {
        name: "row chips condition includes tags",
        from: `                {((item.lastIntent && item.lastIntent !== "general") ||
                  item.leadTemp === "hot" ||
                  Boolean(item.assigneeName)) && (`,
        to: `                {((item.lastIntent && item.lastIntent !== "general") ||
                  item.leadTemp === "hot" ||
                  Boolean(item.assigneeName) ||
                  item.tags.length > 0) && (`,
      },
      {
        name: "row tag chips render",
        from: `                    {item.assigneeName && (
                      <span className="inline-block rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300">
                        {item.assigneeName}
                      </span>
                    )}
                  </div>
                )}`,
        to: `                    {item.assigneeName && (
                      <span className="inline-block rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300">
                        {item.assigneeName}
                      </span>
                    )}
                    {item.tags.slice(0, 2).map((tag) => (
                      <span
                        key={"row-tag-" + tag}
                        className="inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-medium tracking-wide"
                        style={{
                          borderColor: \`hsl(\${tagHue(tag)} 70% 50% / 0.3)\`,
                          backgroundColor: \`hsl(\${tagHue(tag)} 70% 50% / 0.10)\`,
                          color: \`hsl(\${tagHue(tag)} 80% 72%)\`,
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                    {item.tags.length > 2 && (
                      <span className="inline-block rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-slate-400">
                        +{item.tags.length - 2}
                      </span>
                    )}
                  </div>
                )}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "TagsCard import",
        from: `import CodCard from "./CodCard";
import TeamCard from "./TeamCard";`,
        to: `import CodCard from "./CodCard";
import TeamCard from "./TeamCard";
import TagsCard from "./TagsCard";`,
      },
      {
        name: "thread interface tags field",
        from: `  status: string;
  assignedTo: string | null;
}`,
        to: `  status: string;
  assignedTo: string | null;
  tags: string[];
}`,
      },
      {
        name: "TagsCard mounted",
        from: `        <TeamCard
          conversationId={Number(id)}
          initialAssignedTo={conversation?.assignedTo ?? null}
        />
      )}`,
        to: `        <TeamCard
          conversationId={Number(id)}
          initialAssignedTo={conversation?.assignedTo ?? null}
        />
      )}
      {!expired && !notFound && (
        <TagsCard conversationId={Number(id)} initialTags={conversation?.tags ?? []} />
      )}`,
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

  const backup = target.file + ".pre_tags.bak";
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
  [BFF_TAGS_SUMMARY_PATH, BFF_TAGS_SUMMARY_FILE],
  [BFF_CONVERSATION_TAGS_PATH, BFF_CONVERSATION_TAGS_FILE],
  [TAGS_CARD_PATH, TAGS_CARD_FILE],
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
