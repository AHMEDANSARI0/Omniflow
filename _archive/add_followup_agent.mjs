// add_followup_agent.mjs — Follow-up Agent v0 (Phase 3, revenue feature).
// When a customer asks about pricing/stock/buying and then goes silent, the
// agent sends a personalized follow-up after a business-configured delay
// (max attempts, owner-editable template with {name} placeholder). Sensitive
// intents (human request, complaint, refund) cancel the pending follow-up.
// Sending happens through the existing laptop bridge (no Vercel cron needed):
// bridge polls GET /connector/followups (due, enabled, attempts left),
// delivers via adapter.send(OutboundMessage), ingests as direction=out so the
// message appears in the portal thread, then acks (attempts/stage update).
//
// Run from the bot ROOT (folder containing Omniflow/, OmniFlow-Control-Plane/,
// and src/):
//   node add_followup_agent.mjs
//
// CRLF-tolerant, idempotent, backups: *.pre_fu.bak
// Python files are byte-compiled after patching (auto-restore on failure).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_followups.py";
const MIGRATION_PATH =
  "OmniFlow-Control-Plane/migrations/011_followups.sql";
const BFF_FOLLOWUPS_PATH =
  "Omniflow/app/api/omniflow/portal/followups/route.ts";
const FORM_PATH =
  "Omniflow/app/dashboard/(portal)/bot/FollowupSettingsForm.tsx";

const MODULE_FILE = `"""Portal follow-up agent (customer Bearer + connector service key).

Businesses configure: enabled, delay hours, max attempts, message template
({name} = customer first name). A follow-up is armed when an inbound message
classifies as pricing/availability/purchase_intent and cancelled when the
customer sends anything else (including sensitive intents). The laptop
connector polls due follow-ups, delivers them through the WhatsApp adapter
and acks; attempts and stage are tracked here.
"""

import logging
import os
import secrets
from typing import Any, Optional

from flask import Blueprint, jsonify, request

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db


logger = logging.getLogger("omniflow.portal-followups")

bp = Blueprint("portal_followups", __name__, url_prefix="/api/v1")

DEFAULT_TEMPLATE = (
    "Hi {name}! Following up on your question — if you need any more "
    "details or want to place an order, just let me know. Happy to help!"
)

QUALIFYING_INTENTS = ("pricing", "availability", "purchase_intent")


def _service_key_ok():
    provided = request.headers.get("X-Omniflow-Key", "")
    expected = (
        os.environ.get("OMNIFLOW_SERVICE_KEY", "")
        or os.environ.get("OMNIFLOW_ADMIN_API_KEY", "")
    ).strip()
    return bool(expected) and secrets.compare_digest(provided, expected)


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


def _load_settings(cur, client_id):
    cur.execute(
        "SELECT enabled, delay_hours, max_attempts, message_template"
        " FROM " + portal_db._q("portal_followup_settings") +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    found = portal_db.rows(cur)
    if not found:
        return {"enabled": False, "delay_hours": 24, "max_attempts": 2,
                "message_template": ""}
    row = found[0]
    return {
        "enabled": bool(row.get("enabled")),
        "delay_hours": int(row.get("delay_hours") or 24),
        "max_attempts": int(row.get("max_attempts") or 2),
        "message_template": row.get("message_template") or "",
    }


def _public(settings):
    return {
        "enabled": settings["enabled"],
        "delay_hours": settings["delay_hours"],
        "max_attempts": settings["max_attempts"],
        "message_template": settings["message_template"],
    }


@bp.get("/portal/followups")
def get_followup_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                settings = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "followups read")[0]), 503
    return jsonify({"settings": _public(settings)}), 200


@bp.put("/portal/followups")
def put_followup_settings():
    principal, error = _principal_or_error()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    settings = payload.get("settings")
    if not isinstance(settings, dict):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "settings object is required."}}), 400

    enabled = bool(settings.get("enabled"))
    raw_delay = settings.get("delay_hours")
    raw_attempts = settings.get("max_attempts")
    template = settings.get("message_template")
    template = template if isinstance(template, str) else ""

    try:
        delay_hours = int(raw_delay)
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "delay_hours must be a number."}}), 400
    try:
        max_attempts = int(raw_attempts)
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "max_attempts must be a number."}}), 400
    if not 1 <= delay_hours <= 168:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "delay_hours must be 1-168."}}), 400
    if not 1 <= max_attempts <= 3:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "max_attempts must be 1-3."}}), 400
    if len(template) > 1000:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Template must be under 1000 characters."}}), 400

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q("portal_followup_settings") +
                    " (client_id, enabled, delay_hours, max_attempts,"
                    " message_template, updated_at) "
                    "VALUES (%s, %s, %s, %s, %s, NOW()) "
                    "ON CONFLICT (client_id) DO UPDATE SET "
                    " enabled = EXCLUDED.enabled,"
                    " delay_hours = EXCLUDED.delay_hours,"
                    " max_attempts = EXCLUDED.max_attempts,"
                    " message_template = EXCLUDED.message_template,"
                    " updated_at = NOW()",
                    (principal["client_id"], enabled, delay_hours,
                     max_attempts, template),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "followups write")[0]), 503
    return jsonify({"ok": True}), 200


def _render_template(template, contact_name):
    base = (template or "").strip() or DEFAULT_TEMPLATE
    clean_name = str(contact_name or "").strip()
    first_name = clean_name.split(" ")[0] if clean_name else "there"
    return base.replace("{name}", first_name)


@bp.get("/connector/followups")
def connector_due_followups():
    if not _service_key_ok():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403
    try:
        client_id = int(request.args.get("client_id", "1"))
    except (TypeError, ValueError):
        client_id = 1
    try:
        limit = int(request.args.get("limit", "5"))
    except (TypeError, ValueError):
        limit = 5
    limit = max(1, min(5, limit))

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                settings = _load_settings(cur, client_id)
                if not settings["enabled"]:
                    return jsonify({"followups": []}), 200
                cur.execute(
                    "SELECT f.id, f.conversation_id, f.contact_id,"
                    " f.contact_name, f.attempts, s.message_template"
                    " FROM " + portal_db._q("portal_followups") + " f"
                    " JOIN " + portal_db._q("portal_followup_settings") +
                    " s ON s.client_id = f.client_id"
                    " WHERE f.client_id = %s AND f.stage = 'waiting'"
                    " AND f.attempts < s.max_attempts"
                    " AND f.next_due_at IS NOT NULL AND f.next_due_at <= NOW()"
                    " ORDER BY f.next_due_at LIMIT %s",
                    (client_id, limit),
                )
                due = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "followups due")[0]), 503

    items = []
    for row in due:
        items.append({
            "id": row.get("id"),
            "conversation_id": row.get("conversation_id"),
            "external_user_id": row.get("contact_id"),
            "contact_name": row.get("contact_name"),
            "attempts": row.get("attempts"),
            "body": _render_template(
                settings["message_template"], row.get("contact_name")
            ),
        })
    return jsonify({"followups": items}), 200


@bp.post("/connector/followups/ack")
def connector_followup_ack():
    if not _service_key_ok():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403
    payload = request.get_json(silent=True) or {}
    try:
        followup_id = int(payload.get("followup_id"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "followup_id is required."}}), 400
    ok = bool(payload.get("ok"))
    note = payload.get("note") if isinstance(payload.get("note"), str) else None

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q("portal_followups") + " f"
                    " SET attempts = f.attempts + 1,"
                    " stage = CASE WHEN f.attempts + 1 >="
                    " COALESCE(s.max_attempts, 2) THEN 'done'"
                    " ELSE 'waiting' END,"
                    " next_due_at = NOW()"
                    " + make_interval(hours => COALESCE(s.delay_hours, 24)),"
                    " last_note = %s, updated_at = NOW()"
                    " FROM " + portal_db._q("portal_followup_settings") + " s"
                    " WHERE s.client_id = f.client_id AND f.id = %s"
                    " RETURNING f.stage, f.attempts",
                    (note, followup_id),
                )
                updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "followups ack")[0]), 503

    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Follow-up not found."}}), 404
    logger.info(
        "followup ack id=%s ok=%s stage=%s attempts=%s",
        followup_id, ok, updated[0].get("stage"), updated[0].get("attempts"),
    )
    return jsonify({"ok": True}), 200


def update_followup_state(client_id, conversation_id, contact_id,
                          contact_name, intent, conn):
    """Arm/cancel the conversation follow-up inside the ingest transaction.

    Qualifying inbound intents arm (or re-arm) the follow-up; any other
    inbound intent cancels a waiting one. Outbound messages (intent None)
    are ignored. Never raises into the caller: wrap in try/except there.
    """
    if intent is None:
        return
    with conn.cursor() as cur:
        settings = _load_settings(cur, client_id)
        if not settings["enabled"]:
            return
        delay_hours = settings["delay_hours"]
        if intent in QUALIFYING_INTENTS:
            cur.execute(
                "INSERT INTO " + portal_db._q("portal_followups") +
                " (client_id, conversation_id, contact_id, contact_name,"
                " stage, intent, attempts, next_due_at)"
                " VALUES (%s, %s, %s, %s, 'waiting', %s, 0,"
                " NOW() + make_interval(hours => %s))"
                " ON CONFLICT (conversation_id) DO UPDATE SET"
                " stage = 'waiting', intent = EXCLUDED.intent,"
                " contact_id = EXCLUDED.contact_id,"
                " contact_name = EXCLUDED.contact_name,"
                " next_due_at = NOW() + make_interval(hours => %s),"
                " updated_at = NOW()",
                (client_id, conversation_id, contact_id, contact_name,
                 intent, delay_hours, delay_hours),
            )
        else:
            cur.execute(
                "UPDATE " + portal_db._q("portal_followups") +
                " SET stage = 'cancelled', updated_at = NOW()"
                " WHERE conversation_id = %s AND stage = 'waiting'",
                (conversation_id,),
            )
`;

const MIGRATION_FILE = `-- 011: follow-up agent (settings + queue)
-- Applied automatically by portal_db.ensure_tables(); kept here as the
-- canonical migration record (001-011).
CREATE TABLE IF NOT EXISTS portal_followup_settings (
  client_id BIGINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  delay_hours INT NOT NULL DEFAULT 24,
  max_attempts INT NOT NULL DEFAULT 2,
  message_template TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_followups (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL UNIQUE,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  stage TEXT NOT NULL DEFAULT 'waiting',
  intent TEXT,
  attempts INT NOT NULL DEFAULT 0,
  last_note TEXT,
  next_due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_followups_due
  ON portal_followups (client_id, stage, next_due_at);
`;

const BFF_FOLLOWUPS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getFollowupSettings,
  requirePortalAccessToken,
  saveFollowupSettings,
  type FollowupSettings,
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
    const settings = await getFollowupSettings(accessToken);
    if (settings === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ settings }, 200);
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
    settings?: {
      enabled?: unknown;
      delayHours?: unknown;
      maxAttempts?: unknown;
      messageTemplate?: unknown;
    };
  } | null;
  const input = payload?.settings;
  if (!input) {
    return safeJson(
      { error: { code: "bad_request", message: "settings object is required." } },
      400
    );
  }

  const delayHours = Number(input.delayHours);
  const maxAttempts = Number(input.maxAttempts);
  const messageTemplate =
    typeof input.messageTemplate === "string" ? input.messageTemplate : "";
  if (!Number.isInteger(delayHours) || delayHours < 1 || delayHours > 168) {
    return safeJson(
      { error: { code: "bad_request", message: "Delay must be 1-168 hours." } },
      400
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    return safeJson(
      { error: { code: "bad_request", message: "Attempts must be 1-3." } },
      400
    );
  }
  if (messageTemplate.length > 1000) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Template must be under 1000 characters.",
        },
      },
      400
    );
  }

  const settings: FollowupSettings = {
    enabled: input.enabled === true,
    delayHours,
    maxAttempts,
    messageTemplate,
  };

  try {
    const ok = await saveFollowupSettings(accessToken, settings);
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const FORM_FILE = `"use client";

import { useState } from "react";
import type { FollowupSettings } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function FollowupSettingsForm({
  initial,
}: {
  initial: FollowupSettings | null;
}) {
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [delayHours, setDelayHours] = useState(initial?.delayHours ?? 24);
  const [maxAttempts, setMaxAttempts] = useState(initial?.maxAttempts ?? 2);
  const [messageTemplate, setMessageTemplate] = useState(
    initial?.messageTemplate ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  async function save() {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/followups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          settings: {
            enabled,
            delayHours,
            maxAttempts,
            messageTemplate,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Follow-up settings saved." });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Follow-up agent</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Automatically follows up with customers who went silent after asking
            about pricing, stock, or buying. Stops as soon as the customer
            replies or asks for a human.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((value) => !value)}
          aria-pressed={enabled}
          className={\`relative h-6 w-11 shrink-0 rounded-full transition-colors \${
            enabled ? "bg-cyan-400" : "bg-white/[0.1]"
          }\`}
        >
          <span
            className={\`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all \${
              enabled ? "left-[22px]" : "left-0.5"
            }\`}
          />
        </button>
      </div>

      {initial === null ? (
        <p className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] px-4 py-3 text-xs leading-relaxed text-cyan-200/90">
          The follow-up module is rolling out on the server — configure it now;
          it syncs automatically after the deploy.
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="fuDelay" className={labelClass}>
                Wait before follow-up (hours)
              </label>
              <input
                id="fuDelay"
                type="number"
                min={1}
                max={168}
                value={delayHours}
                onChange={(e) => setDelayHours(Number(e.target.value))}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="fuAttempts" className={labelClass}>
                Maximum attempts
              </label>
              <select
                id="fuAttempts"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value))}
                className={\`\${inputClass} cursor-pointer\`}
              >
                <option value={1} className="bg-[#081522]">
                  1
                </option>
                <option value={2} className="bg-[#081522]">
                  2
                </option>
                <option value={3} className="bg-[#081522]">
                  3
                </option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="fuTemplate" className={labelClass}>
              Message template
            </label>
            <textarea
              id="fuTemplate"
              rows={3}
              maxLength={1000}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              placeholder={
                "Hi {name}! Following up on your question — if you need any more details or want to place an order, just let me know."
              }
              className={\`\${inputClass} resize-y\`}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              {"{name}"} is replaced with the customer&apos;s first name. Leave
              empty to use the default message.
            </p>
          </div>

          {message && (
            <p
              role="status"
              className={\`rounded-lg border px-3 py-2 text-xs leading-relaxed \${
                message.kind === "ok"
                  ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                  : "border-red-400/20 bg-red-400/[0.06] text-red-300"
              }\`}
            >
              {message.text}
            </p>
          )}

          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save follow-up settings"}
          </button>
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
        name: "lazy follow-up tables",
        from: `ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS intent TEXT;
ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS last_intent TEXT;
"""`,
        to: `ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS intent TEXT;
ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS last_intent TEXT;
CREATE TABLE IF NOT EXISTS portal_followup_settings (
  client_id BIGINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  delay_hours INT NOT NULL DEFAULT 24,
  max_attempts INT NOT NULL DEFAULT 2,
  message_template TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_followups (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL UNIQUE,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  stage TEXT NOT NULL DEFAULT 'waiting',
  intent TEXT,
  attempts INT NOT NULL DEFAULT 0,
  last_note TEXT,
  next_due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_followups_due
  ON portal_followups (client_id, stage, next_due_at);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import followups blueprint",
        from: `from connector_api import bp as connector_api_bp  # noqa: E402`,
        to: `from connector_api import bp as connector_api_bp  # noqa: E402
from portal_followups import bp as portal_followups_bp  # noqa: E402`,
      },
      {
        name: "register followups blueprint",
        from: `aux_app.register_blueprint(connector_api_bp)`,
        to: `aux_app.register_blueprint(connector_api_bp)
aux_app.register_blueprint(portal_followups_bp)`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      {
        name: "import followups helper",
        from: `from intent_classifier import classify_intent`,
        to: `from intent_classifier import classify_intent
import portal_followups`,
      },
      {
        name: "arm/cancel follow-up inside ingest",
        from: `                         "received" if item["direction"] == "in" else "sent",
                         item["intent"]),
                    )`,
        to: `                         "received" if item["direction"] == "in" else "sent",
                         item["intent"]),
                    )
                    try:
                        portal_followups.update_followup_state(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["intent"],
                            conn,
                        )
                    except Exception:
                        pass`,
      },
    ],
  },

  // ---------------------------------------------------------- laptop bridge
  {
    file: "src/control_plane_bridge.py",
    swaps: [
      {
        name: "followups processed each poll",
        from: `    def run_due_commands(
        self,
        adapter,
        stop_requested=None,
    ):
        commands = self.fetch_commands()`,
        to: `    def run_due_commands(
        self,
        adapter,
        stop_requested=None,
    ):
        try:
            self.process_due_followups(adapter)
        except Exception as followup_error:
            print(f"CP bridge followups warning: {followup_error}")

        commands = self.fetch_commands()`,
      },
      {
        name: "followups delivery methods",
        from: `            print(
                "CP bridge command "
                f"{command_id} ({action}): "
                + ("done" if ok else "failed")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )`,
        to: `            print(
                "CP bridge command "
                f"{command_id} ({action}): "
                + ("done" if ok else "failed")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )

    # ---------- follow-ups ----------

    def fetch_due_followups(self, limit=5):
        status, data = self._request(
            "GET",
            "/api/v1/connector/followups?client_id="
            + str(self.client_id)
            + "&limit="
            + str(int(limit)),
        )
        if status != 200:
            return []
        followups = data.get("followups") if isinstance(data, dict) else None
        if not isinstance(followups, list):
            return []
        return followups

    def acknowledge_followup(self, followup_id, ok, note=None):
        self._request(
            "POST",
            "/api/v1/connector/followups/ack",
            {
                "followup_id": followup_id,
                "ok": bool(ok),
                "note": note,
            },
        )

    def process_due_followups(self, adapter):
        try:
            followups = self.fetch_due_followups()
        except Exception as error:
            print(f"CP bridge followups warning: {error}")
            return
        if not followups:
            return

        try:
            from channels.contracts import OutboundMessage
        except ImportError:
            from src.channels.contracts import OutboundMessage

        account_id = getattr(
            getattr(adapter, "account", None), "id", 0
        )

        for followup in followups:
            followup_id = followup.get("id")
            if not isinstance(followup_id, int):
                continue

            target_user = str(
                followup.get("external_user_id") or ""
            ).strip()
            body_text = str(followup.get("body") or "").strip()
            display_name = followup.get("contact_name")

            if not target_user or not body_text:
                self.acknowledge_followup(
                    followup_id, False, "Invalid follow-up payload."
                )
                continue

            send_result = None
            note = None
            try:
                send_result = adapter.send(
                    OutboundMessage(
                        channel_account_id=int(account_id or 0),
                        external_user_id=target_user,
                        content=body_text,
                        message_type="text",
                        metadata=(
                            {"target_display_name": display_name}
                            if display_name
                            else {}
                        ),
                    )
                )
            except Exception as error:
                note = f"Follow-up send error: {error}"

            success = (
                send_result is not None
                and send_result.success
            )

            if success:
                try:
                    self.ingest_message(
                        external_user_id=target_user,
                        body=body_text,
                        direction="out",
                    )
                except Exception:
                    pass
                note = "Follow-up sent."
            elif send_result is not None:
                note = "Follow-up send failed: " + str(
                    send_result.error or "unknown error"
                )

            self.acknowledge_followup(followup_id, success, note)

            print(
                "CP bridge follow-up "
                f"{followup_id}: "
                + ("sent" if success else "failed/deferred")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )`,
      },
    ],
  },

  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "follow-up settings helpers",
        from: `export type ConversationStatusResult =`,
        to: `export interface FollowupSettings {
  enabled: boolean;
  delayHours: number;
  maxAttempts: number;
  messageTemplate: string;
}

export async function getFollowupSettings(
  accessToken: string
): Promise<FollowupSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/followups");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).settings;
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  return {
    enabled: p.enabled === true,
    delayHours: typeof p.delay_hours === "number" ? p.delay_hours : 24,
    maxAttempts: typeof p.max_attempts === "number" ? p.max_attempts : 2,
    messageTemplate: typeof p.message_template === "string" ? p.message_template : "",
  };
}

export async function saveFollowupSettings(
  accessToken: string,
  settings: FollowupSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/followups", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          enabled: settings.enabled,
          delay_hours: settings.delayHours,
          max_attempts: settings.maxAttempts,
          message_template: settings.messageTemplate,
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
    file: "Omniflow/app/dashboard/(portal)/bot/page.tsx",
    swaps: [
      {
        name: "imports gain followups",
        from: `import { getBotConfig } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import BotForm from "./BotForm";`,
        to: `import { getBotConfig, getFollowupSettings } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import BotForm from "./BotForm";
import FollowupSettingsForm from "./FollowupSettingsForm";`,
      },
      {
        name: "page fetches followup settings",
        from: `  const config = accessToken ? await getBotConfig(accessToken) : null;`,
        to: `  const config = accessToken ? await getBotConfig(accessToken) : null;
  const followupSettings = accessToken
    ? await getFollowupSettings(accessToken)
    : null;`,
      },
      {
        name: "page renders followup card",
        from: `      <BotForm
        initial={config}
        backendConfigured={config?.configured ?? false}
      />`,
        to: `      <BotForm
        initial={config}
        backendConfigured={config?.configured ?? false}
      />

      <div className="mt-6">
        <FollowupSettingsForm initial={followupSettings} />
      </div>`,
      },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(path) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", path], { stdio: "pipe" });
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

  const backup = target.file + ".pre_fu.bak";
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
  [BFF_FOLLOWUPS_PATH, BFF_FOLLOWUPS_FILE],
  [FORM_PATH, FORM_FILE],
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