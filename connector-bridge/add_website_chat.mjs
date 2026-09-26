// add_website_chat.mjs — Phase 10: Website Chat Widget v0 (zero AI cost).
//
// A floating chat bubble on the marketing website. Visitors chat without
// signing in; messages become portal conversations with channel "website"
// ("web_<visitor>" contacts) and land in the SAME inbox as WhatsApp. When
// KB auto-reply is enabled and an entry keyword-matches, the visitor gets
// an instant answer (deterministic, zero AI). Website replies are written
// straight into portal_messages — they NEVER enter the WhatsApp command
// queue, so the home-laptop bridge is untouched and nothing can leak a web
// reply to a WhatsApp number. From the portal thread, the team replies
// normally; the reply endpoint detects channel "website" and delivers the
// message inside the widget (direct insert) instead of queueing a command.
//
// Zero AI cost. No bridge changes -> NO bot restart. New public
// portal_widget.py blueprint (widget settings singleton seeded from the
// first workspace), widget BFF routes + shared transport helper, the
// WebsiteChatWidget bubble on the marketing site (hidden on /dashboard and
// /admin), and WhatsApp-only gating for CodCard/RatingCard in the thread.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_website_chat.mjs
//
// Requires Phase 9 (add_growth_ops.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_chat.bak
// Expected first run: 15 applied / 0 warnings (10 swaps + 5 new files).
// Expected rerun:     0 applied / 10 already done / 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_widget.py";
const TRANSPORT_PATH = "Omniflow/lib/omniflow/widget-transport.ts";
const BFF_CONFIG_PATH = "Omniflow/app/api/omniflow/widget/config/route.ts";
const BFF_CHAT_PATH = "Omniflow/app/api/omniflow/widget/chat/route.ts";
const WIDGET_COMPONENT_PATH = "Omniflow/app/components/WebsiteChatWidget.tsx";

const PY_MODULE = `"""Public website chat widget backend.

Visitors chat from the marketing site without signing in. Messages become
portal conversations with channel "website" (contact "web_<visitor_id>")
and land in the same inbox as WhatsApp. When KB auto-reply is enabled and
an entry keyword-matches, the visitor receives an instant answer: the
reply is written directly into portal_messages and returned to the widget,
NEVER queued as a WhatsApp command. All deterministic: zero AI cost, no
bridge changes, no bot restart.
"""

import logging
import re
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
import portal_kb
import intent_classifier


logger = logging.getLogger("omniflow.portal-widget")

bp = Blueprint("portal_widget", __name__, url_prefix="/api/v1")

WIDGET_TABLE = portal_db.WIDGET_TABLE

VISITOR_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_TEXT = 1000
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_INBOUND = 12
DEFAULT_WELCOME = "Hi! Message us here and we will reply right away."


def _iso(value) -> Optional[str]:
    """ISO-8601 string for timestamps coming out of the driver, else None."""
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _widget_client(cur) -> Optional[Dict[str, Any]]:
    """The widget settings singleton (row id = 1), seeded lazily from the
    first registered workspace so the widget works with zero setup."""
    cur.execute(
        "SELECT client_id, enabled, business_name, welcome_text FROM "
        + portal_db._q(WIDGET_TABLE) + " WHERE id = 1 LIMIT 1"
    )
    rows = portal_db.rows(cur)
    if rows:
        return rows[0]
    cur.execute(
        "SELECT MIN(client_id) AS client_id FROM "
        + portal_db._q(portal_db.USERS_TABLE)
    )
    seed = portal_db.rows(cur)
    client_id = seed[0].get("client_id") if seed else None
    if client_id is None:
        return None
    cur.execute(
        "INSERT INTO " + portal_db._q(WIDGET_TABLE) +
        " (id, client_id, enabled, business_name, welcome_text)"
        " VALUES (1, %s, TRUE, '', %s)"
        " ON CONFLICT (id) DO NOTHING",
        (client_id, DEFAULT_WELCOME),
    )
    cur.execute(
        "SELECT client_id, enabled, business_name, welcome_text FROM "
        + portal_db._q(WIDGET_TABLE) + " WHERE id = 1 LIMIT 1"
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _widget_enabled(cur) -> Optional[Dict[str, Any]]:
    cfg = _widget_client(cur)
    if not cfg or not cfg.get("enabled") or cfg.get("client_id") is None:
        return None
    return cfg


def _message_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "direction": row.get("direction") or "in",
        "body": row.get("body") or "",
        "created_at": _iso(row.get("created_at")),
    }


def _auto_answer(cur, client_id, conversation_id, message_text, intent) \
        -> Optional[Tuple[str, Any]]:
    """Instant KB answer for a website visitor: insert the outbound message
    directly (no WhatsApp command) and return (body, created_at)."""
    if intent not in portal_kb.KB_AUTO_INTENTS:
        return None
    cur.execute(
        "SELECT auto_reply FROM " + portal_db._q(portal_kb.KB_SETTINGS_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    settings_rows = portal_db.rows(cur)
    if not settings_rows or settings_rows[0].get("auto_reply") is not True:
        return None
    entry = portal_kb.match_knowledge_base(cur, client_id, message_text)
    if entry is None:
        return None
    rendered = str(entry.get("content") or "").replace("{name}", "there").strip()
    if not rendered:
        return None
    rendered = rendered[:1000]
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
        " (conversation_id, client_id, direction, body, sender_name,"
        " status, intent, created_at)"
        " VALUES (%s, %s, 'out', %s, NULL, 'sent', NULL, NOW())"
        " RETURNING id, created_at",
        (conversation_id, client_id, rendered),
    )
    out_rows = portal_db.rows(cur)
    cur.execute(
        "UPDATE " + portal_db._q(portal_kb.KB_TABLE) +
        " SET usage_count = usage_count + 1 WHERE id = %s",
        (int(entry.get("id") or 0),),
    )
    cur.execute(
        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
        " SET last_message_preview = %s, last_message_at = NOW(),"
        " updated_at = NOW() WHERE id = %s AND client_id = %s",
        (rendered[:120], conversation_id, client_id),
    )
    portal_db.log_action(
        cur,
        client_id,
        "kb.auto_reply",
        "system",
        None,
        conversation_id,
        "Website auto-answer: " + str(entry.get("title") or ""),
    )
    created = out_rows[0].get("created_at") if out_rows else None
    return rendered, created


@bp.get("/widget/config")
def widget_config():
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cfg = _widget_client(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "widget config")[0]), 503
    if not cfg or not cfg.get("enabled") or cfg.get("client_id") is None:
        return jsonify({"enabled": False}), 200
    return jsonify({
        "enabled": True,
        "business_name": str(cfg.get("business_name") or ""),
        "welcome_text": str(cfg.get("welcome_text") or "") or DEFAULT_WELCOME,
    }), 200


@bp.post("/widget/chat")
def widget_send():
    payload = request.get_json(silent=True) or {}
    visitor = str(payload.get("visitor_id") or "")
    text = str(payload.get("text") or "").strip()
    if not VISITOR_RE.match(visitor):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Invalid visitor."}}), 400
    if not text:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message text is required."}}), 400
    if len(text) > MAX_TEXT:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message too long."}}), 400
    intent = intent_classifier.classify_intent(text)
    reply_body = None
    reply_created = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cfg = _widget_enabled(cur)
                if not cfg:
                    return jsonify({"error": {"code": "widget_disabled",
                                              "message": "Chat is not available."}}), 403
                client_id = int(cfg["client_id"])
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CONV_TABLE) +
                    " (client_id, channel, contact_id, contact_name,"
                    " status, last_message_preview, last_message_at,"
                    " last_intent, created_at, updated_at) "
                    "VALUES (%s, 'website', %s, 'Website visitor', 'open',"
                    " %s, NOW(), %s, NOW(), NOW()) "
                    "ON CONFLICT (client_id, channel, contact_id) DO UPDATE SET "
                    " last_message_preview = EXCLUDED.last_message_preview, "
                    " last_message_at = EXCLUDED.last_message_at, "
                    " last_intent = COALESCE(EXCLUDED.last_intent, "
                    " " + portal_db._q(portal_db.CONV_TABLE) + ".last_intent), "
                    " updated_at = NOW() "
                    "RETURNING id",
                    (client_id, "web_" + visitor, text[:120], intent),
                )
                conv_rows = portal_db.rows(cur)
                conversation_id = int(conv_rows[0]["id"]) if conv_rows else 0
                if not conversation_id:
                    return jsonify({"error": {"code": "widget_unavailable",
                                              "message": "Try again shortly."}}), 503
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE conversation_id = %s AND direction = 'in'"
                    " AND created_at > NOW() - make_interval(secs => %s)",
                    (conversation_id, RATE_LIMIT_WINDOW_SECONDS),
                )
                count_rows = portal_db.rows(cur)
                if count_rows and int(count_rows[0].get("total") or 0) >= RATE_LIMIT_MAX_INBOUND:
                    return jsonify({"error": {"code": "rate_limited",
                                              "message": "Too many messages — slow down a little."}}), 429
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                    " (conversation_id, client_id, direction, body,"
                    " sender_name, status, intent, created_at)"
                    " VALUES (%s, %s, 'in', %s, NULL, 'received', %s, NOW())",
                    (conversation_id, client_id, text, intent),
                )
                auto = _auto_answer(cur, client_id, conversation_id, text, intent)
                if auto is not None:
                    reply_body, reply_created = auto
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "website widget chat")[0]), 503
    return jsonify({"ok": True, "reply": ({
        "body": reply_body,
        "created_at": _iso(reply_created),
    } if reply_body else None)}), 200


@bp.get("/widget/chat")
def widget_poll():
    visitor = request.args.get("visitor_id") or ""
    if not VISITOR_RE.match(visitor):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Invalid visitor."}}), 400
    raw_since = request.args.get("since") or "0"
    try:
        since = int(raw_since)
    except (TypeError, ValueError):
        since = 0
    conversation_id = None
    messages: list = []
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cfg = _widget_enabled(cur)
                if not cfg:
                    return jsonify({"error": {"code": "widget_disabled",
                                              "message": "Chat is not available."}}), 403
                client_id = int(cfg["client_id"])
                cur.execute(
                    "SELECT id FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND channel = 'website'"
                    " AND contact_id = %s LIMIT 1",
                    (client_id, "web_" + visitor),
                )
                found = portal_db.rows(cur)
                if found:
                    conversation_id = int(found[0]["id"])
                    if since > 0:
                        cur.execute(
                            "SELECT id, direction, body, created_at FROM "
                            + portal_db._q(portal_db.MSGS_TABLE) +
                            " WHERE conversation_id = %s AND id > %s"
                            " ORDER BY id ASC LIMIT 100",
                            (conversation_id, since),
                        )
                        messages = portal_db.rows(cur)
                    else:
                        cur.execute(
                            "SELECT id, direction, body, created_at FROM "
                            + portal_db._q(portal_db.MSGS_TABLE) +
                            " WHERE conversation_id = %s"
                            " ORDER BY id DESC LIMIT 50",
                            (conversation_id,),
                        )
                        messages = list(reversed(portal_db.rows(cur)))
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "widget poll")[0]), 503
    return jsonify({
        "conversation_id": conversation_id,
        "messages": [_message_public(m) for m in messages],
    }), 200
`;

const TRANSPORT_FILE = `/**
 * Server-side transport for the public website chat widget. The widget has
 * no portal session, so these calls carry no bearer token — the Control
 * Plane widget endpoints are public by design. Same TLS hygiene as the
 * authenticated portal transport.
 */

export function widgetControlPlaneUrl(path: string): string {
  const raw = process.env.OMNIFLOW_CONTROL_PLANE_URL?.trim();
  if (!raw) throw new Error("control_plane_not_configured");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("control_plane_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("control_plane_url_invalid");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("control_plane_tls_required");
  }

  return url.origin + url.pathname.replace(/\\/$/, "") + path;
}

export async function widgetControlPlaneFetch(
  path: string,
  init?: RequestInit
): Promise<Response | null> {
  try {
    return await fetch(widgetControlPlaneUrl(path), {
      ...init,
      cache: "no-store",
    });
  } catch {
    return null;
  }
}
`;

const BFF_CONFIG_FILE = `import { safeJson } from "../../../../../lib/omniflow/request-security";
import { widgetControlPlaneFetch } from "../../../../../lib/omniflow/widget-transport";

export async function GET() {
  try {
    const response = await widgetControlPlaneFetch("/api/v1/widget/config");
    if (!response || !response.ok) {
      return safeJson({ enabled: false }, 200);
    }
    const data = (await response.json().catch(() => null)) as unknown;
    if (data === null || typeof data !== "object") {
      return safeJson({ enabled: false }, 200);
    }
    return safeJson(data, 200);
  } catch {
    return safeJson({ enabled: false }, 200);
  }
}
`;

const BFF_CHAT_FILE = `import { safeJson } from "../../../../../lib/omniflow/request-security";
import { widgetControlPlaneFetch } from "../../../../../lib/omniflow/widget-transport";

const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const visitorId = url.searchParams.get("visitor_id") ?? "";
  const since = url.searchParams.get("since") ?? "0";
  if (!VISITOR_RE.test(visitorId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid visitor." } },
      400
    );
  }

  try {
    const response = await widgetControlPlaneFetch(
      "/api/v1/widget/chat?visitor_id=" +
        encodeURIComponent(visitorId) +
        "&since=" +
        encodeURIComponent(since.slice(0, 12))
    );
    if (!response) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (response.status === 403) {
      return safeJson(
        { error: { code: "widget_disabled", message: "Chat is not available." } },
        403
      );
    }
    if (!response.ok) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    const data = (await response.json().catch(() => null)) as unknown;
    if (data === null || typeof data !== "object") {
      return safeJson({ conversation_id: null, messages: [] }, 200);
    }
    return safeJson(data, 200);
  } catch {
    return safeJson(
      { error: { code: "widget_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    visitor_id?: unknown;
    text?: unknown;
  } | null;
  const visitorId =
    typeof payload?.visitor_id === "string" ? payload.visitor_id : "";
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!VISITOR_RE.test(visitorId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid visitor." } },
      400
    );
  }
  if (!text) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text is required." } },
      400
    );
  }
  if (text.length > 1000) {
    return safeJson(
      { error: { code: "bad_request", message: "Message too long." } },
      400
    );
  }

  try {
    const response = await widgetControlPlaneFetch("/api/v1/widget/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: visitorId, text }),
    });
    if (!response) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (response.status === 403) {
      return safeJson(
        { error: { code: "widget_disabled", message: "Chat is not available." } },
        403
      );
    }
    if (response.status === 429) {
      return safeJson(
        {
          error: {
            code: "rate_limited",
            message: "Too many messages — slow down a little.",
          },
        },
        429
      );
    }
    if (!response.ok) {
      return safeJson(
        { error: { code: "widget_unavailable", message: "Try again shortly." } },
        503
      );
    }
    const data = (await response.json().catch(() => null)) as unknown;
    if (data === null || typeof data !== "object") {
      return safeJson({ ok: true, reply: null }, 200);
    }
    return safeJson(data, 200);
  } catch {
    return safeJson(
      { error: { code: "widget_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const WIDGET_COMPONENT_FILE = `"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

interface WidgetConfig {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
}

interface WidgetMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  created_at: string | null;
}

const VISITOR_KEY = "of_widget_visitor";

function resolveVisitorId(): string {
  try {
    const existing = window.localStorage.getItem(VISITOR_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const created =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem(VISITOR_KEY, created);
    return created;
  } catch {
    return "anon" + Date.now().toString(36);
  }
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function WebsiteChatWidget() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [loadedThread, setLoadedThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [visitorId, setVisitorId] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const hidden =
    pathname === null ||
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/admin");

  useEffect(() => {
    setMounted(true);
    setVisitorId(resolveVisitorId());
    let alive = true;
    async function loadConfig() {
      try {
        const response = await fetch("/api/omniflow/widget/config", {
          cache: "no-store",
        });
        if (!response.ok || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          enabled?: boolean;
          business_name?: string;
          welcome_text?: string;
        } | null;
        if (alive && payload?.enabled) {
          setConfig({
            enabled: true,
            businessName: payload.business_name ?? "",
            welcomeText: payload.welcome_text ?? "",
          });
        }
      } catch {
        // The bubble simply stays hidden until the backend answers.
      }
    }
    void loadConfig();
    return () => {
      alive = false;
    };
  }, []);

  const refreshThread = useCallback(
    async (reset: boolean) => {
      if (!visitorId) return;
      try {
        const sinceId =
          !reset && messages.length > 0
            ? String(messages[messages.length - 1].id)
            : "0";
        const response = await fetch(
          "/api/omniflow/widget/chat?visitor_id=" +
            encodeURIComponent(visitorId) +
            "&since=" +
            sinceId,
          { cache: "no-store" }
        );
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as {
          messages?: WidgetMessage[];
        } | null;
        if (payload && Array.isArray(payload.messages)) {
          if (reset) {
            setMessages(payload.messages);
          } else if (payload.messages.length > 0) {
            setMessages((current) => [...current, ...payload.messages!]);
          }
        }
        setLoadedThread(true);
      } catch {
        // Transient network issue — the next poll retries.
      }
    },
    [visitorId, messages]
  );

  useEffect(() => {
    if (!open) return;
    void refreshThread(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshThread(false);
    }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visitorId]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, open]);

  async function send() {
    const text = draft.trim();
    if (busy || !text || !visitorId) return;
    setBusy(true);
    try {
      const response = await fetch("/api/omniflow/widget/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitor_id: visitorId, text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: { body?: string } | null;
      } | null;
      if (response.ok && payload?.ok) {
        setDraft("");
        await refreshThread(true);
      }
    } catch {
      // The visitor can retry — keep the draft.
    } finally {
      setBusy(false);
    }
  }

  if (!mounted || hidden || !config || !config.enabled) return null;

  return (
    <>
      {open && (
        <div
          className="fixed inset-x-3 bottom-3 top-20 z-50 flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#060f1b] shadow-2xl shadow-black/40 sm:inset-x-auto sm:bottom-20 sm:right-5 sm:top-auto sm:h-[540px] sm:w-96"
          role="dialog"
          aria-label="Chat with us"
        >
          <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/[0.06]">
                <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.7)]" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {config.businessName || "Chat with us"}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-emerald-300">
                  Typically replies instantly
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] text-slate-400 transition-colors duration-200 hover:text-white"
            >
              ✕
            </button>
          </div>

          <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto p-4">
            <div className="flex justify-start">
              <p className="max-w-[80%] rounded-2xl rounded-bl-md border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5 text-xs leading-relaxed text-slate-200">
                {config.welcomeText || "Hi! How can we help?"}
              </p>
            </div>
            {loadedThread &&
              messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    "flex " +
                    (message.direction === "in" ? "justify-end" : "justify-start")
                  }
                >
                  <p
                    className={
                      "max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed " +
                      (message.direction === "in"
                        ? "rounded-br-md border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-50"
                        : "rounded-bl-md border border-white/[0.06] bg-white/[0.03] text-slate-200")
                    }
                  >
                    {message.body}
                    {message.created_at ? (
                      <span className="mt-1 block text-[9px] text-slate-500">
                        {formatWhen(message.created_at)}
                      </span>
                    ) : null}
                  </p>
                </div>
              ))}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            className="flex items-center gap-2 border-t border-white/[0.06] bg-white/[0.02] p-3"
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={1000}
              placeholder="Type your message…"
              className="min-w-0 flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.1] px-4 py-2.5 text-xs font-semibold text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.18] disabled:opacity-50"
            >
              {busy ? "…" : "Send"}
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close chat" : "Open chat"}
        className="fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-400 text-lg text-[#07111f] shadow-xl shadow-cyan-500/20 transition-transform duration-200 hover:scale-105"
      >
        {open ? "✕" : "❖"}
      </button>
    </>
  );
}
`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "widget settings table constant",
        from: `CSAT_TABLE = os.environ.get("OF_CSAT_TABLE", "portal_csat_requests")`,
        to: `CSAT_TABLE = os.environ.get("OF_CSAT_TABLE", "portal_csat_requests")
WIDGET_TABLE = os.environ.get("OF_WIDGET_TABLE", "portal_widget_settings")`,
      },
      {
        name: "lazy DDL: widget settings singleton",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_csat
  ON portal_csat_requests (client_id, score);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_csat
  ON portal_csat_requests (client_id, score);
CREATE TABLE IF NOT EXISTS portal_widget_settings (
  id INT PRIMARY KEY,
  client_id BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  business_name TEXT NOT NULL DEFAULT '',
  welcome_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import portal_widget blueprint",
        from: `from portal_growth import bp as portal_growth_bp  # noqa: E402`,
        to: `from portal_growth import bp as portal_growth_bp  # noqa: E402
from portal_widget import bp as portal_widget_bp  # noqa: E402`,
      },
      {
        name: "register portal_widget blueprint",
        from: `aux_app.register_blueprint(portal_growth_bp)`,
        to: `aux_app.register_blueprint(portal_growth_bp)
aux_app.register_blueprint(portal_widget_bp)`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "reply endpoint SELECT carries channel",
        from: `                    "SELECT id, contact_id, contact_name FROM "`,
        to: `                    "SELECT id, channel, contact_id, contact_name FROM "`,
      },
      {
        name: "website conversations deliver in-widget (no WhatsApp command)",
        from: `                contact_id = str(found[0].get("contact_id") or "").strip()
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This conversation has no deliverable contact."}}), 400
                command_payload = {`,
        to: `                contact_id = str(found[0].get("contact_id") or "").strip()
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This conversation has no deliverable contact."}}), 400
                if (found[0].get("channel") or "") == "website":
                    # Website chats deliver inside the widget itself: store
                    # the reply directly instead of queueing a WhatsApp
                    # command (the bridge is WhatsApp-only).
                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                        " (conversation_id, client_id, direction, body,"
                        " sender_name, status, created_at)"
                        " VALUES (%s, %s, 'out', %s, NULL, 'sent', NOW())",
                        (conversation_id, principal["client_id"], body),
                    )
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                        " SET last_message_at = NOW(),"
                        " last_message_preview = %s, updated_at = NOW()"
                        " WHERE id = %s AND client_id = %s",
                        (body[:120], conversation_id, principal["client_id"]),
                    )
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "message.sent",
                        "customer_user",
                        principal.get("user_id"),
                        conversation_id,
                        "Website reply delivered in widget.",
                    )
                    conn.commit()
                    return jsonify({"ok": True, "queued": False,
                                    "command_id": None}), 200
                command_payload = {`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "COD card gated to WhatsApp chats",
        from: `      {!expired && !notFound && <CodCard conversationId={Number(id)} />}`,
        to: `      {!expired && !notFound && conversation?.channel !== "website" && (
        <CodCard conversationId={Number(id)} />
      )}`,
      },
      {
        name: "rating card gated to WhatsApp chats",
        from: `      {!expired && !notFound && <RatingCard conversationId={Number(id)} />}`,
        to: `      {!expired && !notFound && conversation?.channel !== "website" && (
        <RatingCard conversationId={Number(id)} />
      )}`,
      },
    ],
  },
  {
    file: "Omniflow/app/layout.tsx",
    swaps: [
      {
        name: "import website chat widget",
        from: `import { getSiteSettings } from "../lib/settings";`,
        to: `import { getSiteSettings } from "../lib/settings";
import WebsiteChatWidget from "./components/WebsiteChatWidget";`,
      },
      {
        name: "mount website chat widget",
        from: `      <body className={\`\${inter.variable} \${sora.variable}\`}>
        {children}
      </body>`,
        to: `      <body className={\`\${inter.variable} \${sora.variable}\`}>
        {children}
        <WebsiteChatWidget />
      </body>`,
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

  const backup = target.file + ".pre_chat.bak";
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
  [TRANSPORT_PATH, TRANSPORT_FILE],
  [BFF_CONFIG_PATH, BFF_CONFIG_FILE],
  [BFF_CHAT_PATH, BFF_CHAT_FILE],
  [WIDGET_COMPONENT_PATH, WIDGET_COMPONENT_FILE],
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
