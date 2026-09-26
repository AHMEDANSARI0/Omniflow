// add_saved_replies.mjs — Phase 13: Saved Replies (canned responses) v0.
//
// Team inbox deepening (zero AI, no bridge changes -> NO bot restart):
// 1. Saved replies: short-hand templates ("/thanks", "/address", "/timing")
//    managed right on the conversation page — add with a shortcut + message,
//    delete with one click (up to 30 per workspace, body up to 1000 chars).
// 2. One-click insert: a "Saved replies" bar above the composer lists them;
//    tapping one drops the text into the reply box, ready to edit and send.
// 3. Replies are tenant-scoped, audit-logged (saved_reply.created /
//    saved_reply.deleted) and human-only to write — API keys stay read-only.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_saved_replies.mjs
//
// Requires Phase 12 (add_inbox_tags.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_sr.bak
// Expected first run: 9 applied, 0 warnings (6 swaps + 3 new files).
// Expected rerun:     0 applied, 6 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_SAVED_REPLIES_PATH =
  "Omniflow/app/api/omniflow/portal/saved-replies/route.ts";
const BFF_SAVED_REPLY_DELETE_PATH =
  "Omniflow/app/api/omniflow/portal/saved-replies/[id]/route.ts";
const PICKER_PATH =
  "Omniflow/app/dashboard/(portal)/conversations/[id]/SavedRepliesPicker.tsx";

const BFF_SAVED_REPLIES_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createSavedReply,
  listSavedReplies,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

function normalizeShortcut(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^\\/+/, "")
    .trim()
    .toLowerCase()
    .replace(/\\s+/g, "-")
    .slice(0, 24);
}

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listSavedReplies(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ replies: data }, 200);
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
    shortcut?: unknown;
    body?: unknown;
  } | null;
  const shortcut = normalizeShortcut(payload?.shortcut);
  if (!/^[a-z0-9_-]{1,24}$/.test(shortcut)) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message:
            "Shortcut can use letters, numbers, dashes and underscores (max 24).",
        },
      },
      400
    );
  }
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text is required." } },
      400
    );
  }
  if (body.length > 1000) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Message must be 1000 characters or fewer.",
        },
      },
      400
    );
  }

  try {
    const result = await createSavedReply(accessToken, shortcut, body);
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
            message: "Invalid saved reply — check the shortcut and message.",
          },
        },
        400
      );
    }
    if (result.kind === "duplicate") {
      return safeJson(
        {
          error: {
            code: "duplicate",
            message: "A reply with this shortcut already exists.",
          },
        },
        409
      );
    }
    if (result.kind === "limit_reached") {
      return safeJson(
        {
          error: {
            code: "limit_reached",
            message: "Up to 30 saved replies per workspace.",
          },
        },
        409
      );
    }
    return safeJson({ ok: true, reply: result.reply }, 200);
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

const BFF_SAVED_REPLY_DELETE_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteSavedReply,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveReplyId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const replyId = Number(id);
  if (!Number.isInteger(replyId) || replyId <= 0) return null;
  return replyId;
}

export async function DELETE(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const replyId = await resolveReplyId(context);
  if (replyId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid saved reply id." } },
      400
    );
  }

  try {
    const result = await deleteSavedReply(accessToken, replyId);
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

const PICKER_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface SavedReply {
  id: number;
  shortcut: string;
  body: string;
  createdAt: string | null;
}

export default function SavedRepliesPicker({
  onPick,
}: {
  onPick: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/saved-replies", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status !== 200) return;
      const payload = (await response.json().catch(() => null)) as {
        replies?: {
          id?: number;
          shortcut?: string;
          body?: string;
          createdAt?: string | null;
        }[];
      } | null;
      if (payload && Array.isArray(payload.replies)) {
        const next: SavedReply[] = [];
        for (const row of payload.replies) {
          if (row && typeof row.id === "number" &&
              typeof row.shortcut === "string" && typeof row.body === "string") {
            next.push({
              id: row.id,
              shortcut: row.shortcut,
              body: row.body,
              createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
            });
          }
        }
        setReplies(next);
      }
      setLoaded(true);
    } catch {
      // Transient network issue — retry on next open.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addReply() {
    const trimmedShortcut = shortcut.trim();
    const trimmedBody = body.trim();
    if (!trimmedShortcut || !trimmedBody || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/saved-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ shortcut: trimmedShortcut, body: trimmedBody }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: SavedReply;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok && payload.reply) {
        setReplies((current) => [payload.reply as SavedReply, ...current]);
        setShortcut("");
        setBody("");
        setMessage(null);
      } else {
        setMessage(payload?.error?.message || "Could not save the reply.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeReply(reply: SavedReply) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/saved-replies/\${reply.id}\`,
        { method: "DELETE", credentials: "same-origin" }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
      } | null;
      if (response.ok && payload?.ok) {
        setReplies((current) => current.filter((item) => item.id !== reply.id));
      } else {
        setMessage("Could not delete the reply.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  function useReply(reply: SavedReply) {
    onPick(reply.body);
    setOpen(false);
    setMessage("Template inserted into the reply box — edit if needed, then send.");
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          if (!open && !loaded) void load();
        }}
        className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white"
      >
        <span aria-hidden>⚡</span>
        Saved replies
        <span className="rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-slate-500">
          {replies.length}
        </span>
        <span aria-hidden className="text-[10px] text-slate-500">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
          {replies.length > 0 && (
            <ul className="space-y-2">
              {replies.map((reply) => (
                <li
                  key={reply.id}
                  className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <span className="rounded-md border border-cyan-400/20 bg-cyan-400/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
                      /{reply.shortcut}
                    </span>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                      {reply.body}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => useReply(reply)}
                      className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-[11px] font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14]"
                    >
                      Use
                    </button>
                    <button
                      type="button"
                      onClick={() => removeReply(reply)}
                      disabled={busy}
                      aria-label={\`Delete saved reply \${reply.shortcut}\`}
                      className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors duration-300 hover:text-white disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {replies.length === 0 && loaded && (
            <p className="text-xs text-slate-500">
              No saved replies yet — add your first template below (for example
              /thanks for a quick thank-you message).
            </p>
          )}

          <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={shortcut}
                onChange={(event) => setShortcut(event.target.value)}
                maxLength={24}
                placeholder="shortcut, e.g. thanks"
                className="w-full sm:w-56 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
              <input
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={1000}
                placeholder="Message text — what gets inserted"
                className="w-full flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
              <button
                type="button"
                onClick={() => void addReply()}
                disabled={busy || !shortcut.trim() || !body.trim()}
                className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
              >
                {busy ? "Working…" : "Add reply"}
              </button>
            </div>
            {message && <p className="text-xs text-slate-400">{message}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
`;

const PORTAL_TS_SAVED_REPLIES_SECTION = `// ---------------------------------------------------------------------------
// Saved replies (canned response templates)
// ---------------------------------------------------------------------------

export interface SavedReply {
  id: number;
  shortcut: string;
  body: string;
  createdAt: string | null;
}

function normalizeSavedReply(value: unknown): SavedReply | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    shortcut: typeof p.shortcut === "string" ? p.shortcut : "",
    body: typeof p.body === "string" ? p.body : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listSavedReplies(
  accessToken: string
): Promise<SavedReply[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/saved-replies");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).replies;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeSavedReply(row))
    .filter((row): row is SavedReply => row !== null);
}

export type SavedReplyWriteResult =
  | { kind: "ok"; reply: SavedReply }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "limit_reached" };

export async function createSavedReply(
  accessToken: string,
  shortcut: string,
  body: string
): Promise<SavedReplyWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/saved-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut, body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).error !== null &&
      typeof (payload as Record<string, unknown>).error === "object" &&
      ((payload as Record<string, unknown>).error as Record<string, unknown>)
        .code === "limit_reached"
        ? "limit_reached"
        : "duplicate";
    return { kind: code };
  }
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const reply = normalizeSavedReply(
    (payload as Record<string, unknown>).reply
  );
  if (reply === null) return null;
  return { kind: "ok", reply };
}

export async function deleteSavedReply(
  accessToken: string,
  replyId: number
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/saved-replies/" + replyId,
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

const CP_SAVED_REPLIES_APPEND = `


# ---------------------------------------------------------------------------
# Saved replies (canned response templates for the shared inbox)
# ---------------------------------------------------------------------------

MAX_SAVED_REPLIES = 30
MAX_REPLY_BODY = 1000
SHORTCUT_RE = re.compile(r"^[a-z0-9_-]{1,24}$")


def _clean_shortcut(value: Any) -> str:
    """Normalize a shortcut: trim, drop a leading slash, lowercase, cap 24."""
    if not isinstance(value, str):
        return ""
    shortcut = value.strip()
    while shortcut.startswith("/"):
        shortcut = shortcut[1:]
    shortcut = re.sub(r"\\s+", "-", shortcut.strip().lower())
    shortcut = shortcut[:24]
    if not SHORTCUT_RE.match(shortcut):
        return ""
    return shortcut


@bp.get("/saved-replies")
def list_saved_replies():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, shortcut, body, created_at FROM "
                    + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                    (principal["client_id"], MAX_SAVED_REPLIES),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved replies read")[0]), 503
    return jsonify({"replies": [
        {
            "id": int(row.get("id") or 0),
            "shortcut": str(row.get("shortcut") or ""),
            "body": str(row.get("body") or ""),
            "created_at": _iso(row.get("created_at")),
        }
        for row in rows
    ]}), 200


@bp.post("/saved-replies")
def create_saved_reply():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    shortcut = _clean_shortcut(payload.get("shortcut"))
    if not shortcut:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Shortcut can use letters, numbers, dashes and underscores (max 24)."}}), 400
    body_text = payload.get("body")
    body_text = body_text.strip() if isinstance(body_text, str) else ""
    if not body_text:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message text is required."}}), 400
    if len(body_text) > MAX_REPLY_BODY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message must be 1000 characters or fewer."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                counts = portal_db.rows(cur)
                if counts and int(counts[0].get("total") or 0) >= MAX_SAVED_REPLIES:
                    return jsonify({"error": {"code": "limit_reached",
                                              "message": "Up to 30 saved replies per workspace."}}), 409
                cur.execute(
                    "SELECT id FROM " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE client_id = %s AND LOWER(shortcut) = LOWER(%s) LIMIT 1",
                    (principal["client_id"], shortcut),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "duplicate",
                                              "message": "A reply with this shortcut already exists."}}), 409
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " (client_id, shortcut, body, created_at)"
                    " VALUES (%s, %s, %s, NOW()) RETURNING id, shortcut, body, created_at",
                    (principal["client_id"], shortcut, body_text),
                )
                inserted = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "saved_reply.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Saved reply added: /" + shortcut)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply create")[0]), 503
    created = inserted[0] if inserted else {}
    return jsonify({"ok": True, "reply": {
        "id": int(created.get("id") or 0),
        "shortcut": str(created.get("shortcut") or shortcut),
        "body": str(created.get("body") or body_text),
        "created_at": _iso(created.get("created_at")),
    }}), 200


@bp.delete("/saved-replies/<int:reply_id>")
def delete_saved_reply(reply_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING shortcut",
                    (reply_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
                if not deleted:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Saved reply not found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "saved_reply.deleted",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Saved reply deleted: /"
                     + str(deleted[0].get("shortcut") or ""))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply delete")[0]), 503
    return jsonify({"ok": True}), 200
`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "saved replies table constant",
        from: `CONV_TAGS_TABLE = os.environ.get("OF_CONVTAGS_TABLE", "portal_conversation_tags")`,
        to: `CONV_TAGS_TABLE = os.environ.get("OF_CONVTAGS_TABLE", "portal_conversation_tags")
SAVED_REPLIES_TABLE = os.environ.get("OF_SAVEDREPLIES_TABLE", "portal_saved_replies")`,
      },
      {
        name: "saved replies DDL",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_conv_tags_conv
  ON portal_conversation_tags (conversation_id, id);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_conv_tags_conv
  ON portal_conversation_tags (conversation_id, id);
CREATE TABLE IF NOT EXISTS portal_saved_replies (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_saved_reply UNIQUE (client_id, shortcut)
);
CREATE INDEX IF NOT EXISTS idx_portal_saved_replies
  ON portal_saved_replies (client_id, id DESC);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "saved replies endpoints appended",
        from: `    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "label remove")[0]), 503
    return jsonify({"ok": True}), 200`,
        to: `    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "label remove")[0]), 503
    return jsonify({"ok": True}), 200
` + CP_SAVED_REPLIES_APPEND,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "saved replies client functions",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_SAVED_REPLIES_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "SavedRepliesPicker import",
        from: `import TagsCard from "./TagsCard";
import RatingCard from "./RatingCard";`,
        to: `import TagsCard from "./TagsCard";
import RatingCard from "./RatingCard";
import SavedRepliesPicker from "./SavedRepliesPicker";`,
      },
      {
        name: "picker mounted above composer",
        from: `      {!expired && !notFound && (
        <form`,
        to: `      {!expired && !notFound && (
        <SavedRepliesPicker onPick={(text) => setDraft(text)} />
      )}
      {!expired && !notFound && (
        <form`,
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

  const backup = target.file + ".pre_sr.bak";
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
  [BFF_SAVED_REPLIES_PATH, BFF_SAVED_REPLIES_FILE],
  [BFF_SAVED_REPLY_DELETE_PATH, BFF_SAVED_REPLY_DELETE_FILE],
  [PICKER_PATH, PICKER_FILE],
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