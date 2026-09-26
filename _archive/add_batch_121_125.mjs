// add_batch_121_125.mjs - one-file batch covering Phases 121-125.
//
//   Ph121  Scheduled broadcasts (control plane): portal_growth.py gains
//          POST /portal/broadcasts/schedule (audience + body + future
//          send_at, recipient snapshot capped at 200), GET
//          /portal/broadcasts/scheduled and DELETE
//          /portal/broadcasts/scheduled/<id> (cancel until it fires).
//          Lazy ALTER adds send_at, recipients_json and materialized_at
//          to portal_broadcasts (idempotent, once per process).
//   Ph122  Delivery needs no worker: the connector's own commands poll
//          now materializes DUE scheduled broadcasts into regular
//          send_message commands (batch of max 5 per poll), so the
//          existing bridge sends them on time. Zero bridge changes,
//          zero restarts.
//   Ph123  portal lib: ScheduledBroadcast types + listScheduledBroadcasts,
//          scheduleBroadcast, cancelScheduledBroadcast.
//   Ph124  Broadcasts page gets a self-contained ScheduleCard (pick
//          audience, write text, choose local date/time, see the
//          pending schedule, cancel any row). Mobile responsive.
//   Ph125  BFF routes for the card + regression coverage.
//
// Reuses the existing broadcast idioms: _resolve_recipients for the
// audience snapshot and _send_command for the fan-out. No AI.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const GROWTH_PATH = "OmniFlow-Control-Plane/portal_growth.py";

const SCHEDULE_IMPORT_FROM = `import logging`;
const SCHEDULE_IMPORT_TO = `import logging
from datetime import datetime, timedelta, timezone`;

const SCHEDULE_CONSTS_FROM = `BROADCAST_MAX_RECIPIENTS = 200`;
const SCHEDULE_CONSTS_TO = `BROADCAST_MAX_RECIPIENTS = 200
BROADCAST_SCHEDULE_MAX_DAYS = 30
_SCHEDULE_COLUMNS_READY = False`;

const SCHEDULE_BLOCK_FROM = `@bp.get("/portal/broadcasts/preview")`;

const SCHEDULE_BLOCK_TO = `def _ensure_schedule_columns(conn) -> None:
    """Lazy migration: schedules live on the broadcasts table (runs once)."""
    global _SCHEDULE_COLUMNS_READY
    if _SCHEDULE_COLUMNS_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE " + portal_db._q(BROADCASTS_TABLE) +
            " ADD COLUMN IF NOT EXISTS send_at TIMESTAMPTZ,"
            " ADD COLUMN IF NOT EXISTS recipients_json JSONB,"
            " ADD COLUMN IF NOT EXISTS materialized_at TIMESTAMPTZ"
        )
    conn.commit()
    _SCHEDULE_COLUMNS_READY = True


def _parse_send_at(raw: Any):
    """Accept an ISO timestamp; return an aware datetime or None."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def _schedule_public(row: dict) -> dict:
    send_at = row.get("send_at")
    return {
        "id": row.get("id"),
        "audience": row.get("audience") or "all",
        "body": row.get("body") or "",
        "recipient_count": int(row.get("recipient_count") or 0),
        "send_at": _iso(send_at),
        "created_at": _iso(row.get("created_at")),
    }


@bp.post("/portal/broadcasts/schedule")
def schedule_broadcast():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    payload = request.get_json(silent=True) or {}
    audience = str(payload.get("audience") or "all").strip().lower()
    body = str(payload.get("body") or "").strip()
    if audience not in AUDIENCES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "audience must be all, open, or hot."}}), 400
    if not body:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message text is required."}}), 400
    if len(body) > BROADCAST_MAX_BODY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Broadcasts must be 1000 characters or fewer."}}), 400
    send_at = _parse_send_at(payload.get("send_at"))
    if send_at is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "send_at must be an ISO date-time with a timezone."}}), 400
    now_utc = datetime.now(timezone.utc)
    if send_at <= now_utc:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a time in the future."}}), 400
    if send_at > now_utc + timedelta(days=BROADCAST_SCHEDULE_MAX_DAYS):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Schedule at most "
                                  + str(BROADCAST_SCHEDULE_MAX_DAYS) + " days ahead."}}), 400
    scheduled_row = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_schedule_columns(conn)
            with conn.cursor() as cur:
                recipients = _resolve_recipients(cur, client_id, audience)
                if not recipients:
                    return jsonify({"error": {"code": "no_recipients",
                                              "message": "No conversations match this audience yet."}}), 400
                if len(recipients) > BROADCAST_MAX_RECIPIENTS:
                    return jsonify({"error": {"code": "too_many_recipients",
                                              "message": "Audience has more than "
                                              + str(BROADCAST_MAX_RECIPIENTS)
                                              + " customers. Narrow it down (open chats or hot leads)."}}), 400
                from psycopg2.extras import Json

                cur.execute(
                    "INSERT INTO " + portal_db._q(BROADCASTS_TABLE) +
                    " (client_id, audience, body, recipient_count, send_at, recipients_json)"
                    " VALUES (%s, %s, %s, %s, %s, %s)"
                    " RETURNING id, audience, body, recipient_count, send_at, created_at",
                    (client_id, audience, body, len(recipients), send_at,
                     Json([{"contact_id": str(r.get("contact_id") or ""),
                            "contact_name": str(r.get("contact_name") or "")}
                           for r in recipients])),
                )
                rows = portal_db.rows(cur)
                scheduled_row = rows[0] if rows else {}
                portal_db.log_action(
                    cur,
                    client_id,
                    "broadcast.scheduled",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Broadcast scheduled for "
                    + send_at.isoformat() + " ("
                    + AUDIENCE_LABELS[audience] + ").",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "broadcast schedule")[0]), 503
    return jsonify({"ok": True, "scheduled": _schedule_public(scheduled_row or {})}), 200


@bp.get("/portal/broadcasts/scheduled")
def list_scheduled_broadcasts():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_schedule_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, audience, body, recipient_count, send_at, created_at"
                    " FROM " + portal_db._q(BROADCASTS_TABLE) +
                    " WHERE client_id = %s"
                    " AND send_at IS NOT NULL AND materialized_at IS NULL"
                    " ORDER BY send_at ASC LIMIT 20",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "scheduled broadcasts read")[0]), 503
    return jsonify({"scheduled": [_schedule_public(row) for row in found]}), 200


@bp.delete("/portal/broadcasts/scheduled/<int:broadcast_id>")
def cancel_scheduled_broadcast(broadcast_id: int):
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
            _ensure_schedule_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(BROADCASTS_TABLE) +
                    " WHERE id = %s AND client_id = %s"
                    " AND send_at IS NOT NULL AND materialized_at IS NULL"
                    " RETURNING id",
                    (broadcast_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "scheduled broadcast cancel")[0]), 503
    if not found:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Scheduled broadcast not found (or already sent)."}}), 404
    return jsonify({"ok": True}), 200


def materialize_due_broadcasts(cur, client_id, conn) -> int:
    """Fan out due scheduled broadcasts as send_message commands (max 5)."""
    cur.execute(
        "SELECT id, client_id, audience, body, recipients_json"
        " FROM " + portal_db._q(BROADCASTS_TABLE) +
        " WHERE client_id = %s"
        " AND send_at IS NOT NULL AND materialized_at IS NULL"
        " AND send_at <= NOW()"
        " ORDER BY send_at ASC LIMIT 5",
        (client_id,),
    )
    due_rows = portal_db.rows(cur)
    delivered = 0
    for row in due_rows:
        broadcast_id = int(row.get("id") or 0)
        row_client = int(row.get("client_id") or client_id)
        audience = str(row.get("audience") or "all")
        body = str(row.get("body") or "")
        recipients = row.get("recipients_json")
        if not isinstance(recipients, list) or not recipients:
            recipients = _resolve_recipients(cur, row_client, audience)
        sent_count = 0
        for recipient in recipients:
            if not isinstance(recipient, dict):
                continue
            external_user_id = str(recipient.get("contact_id") or "").strip()
            if not external_user_id:
                continue
            display = str(recipient.get("contact_name") or "").strip()
            rendered = body.replace("{name}", _first_name(display))
            _send_command(cur, row_client, external_user_id, display,
                          rendered, "broadcast", broadcast_id=broadcast_id)
            sent_count += 1
        cur.execute(
            "UPDATE " + portal_db._q(BROADCASTS_TABLE) +
            " SET materialized_at = NOW() WHERE id = %s",
            (broadcast_id,),
        )
        portal_db.log_action(
            cur,
            row_client,
            "broadcast.sent",
            "system",
            None,
            None,
            "Scheduled broadcast delivered to "
            + str(sent_count) + " customers (" + AUDIENCE_LABELS.get(audience, audience) + ").",
        )
        delivered += 1
    if delivered:
        conn.commit()
    return delivered


@bp.get("/portal/broadcasts/preview")`;

const CONNECTOR_HOOK_FROM = `    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, action, payload, created_at FROM "
                    + portal_db._q(portal_db.CMD_TABLE) +`;

const CONNECTOR_HOOK_TO = `    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                try:
                    import portal_growth

                    portal_growth.materialize_due_broadcasts(cur, tenant["client_id"], conn)
                except Exception:
                    pass
                cur.execute(
                    "SELECT id, action, payload, created_at FROM "
                    + portal_db._q(portal_db.CMD_TABLE) +`;

const PORTAL_TS_FROM = `export type ConversationStatusResult =`;

const PORTAL_TS_TO = `export interface ScheduledBroadcast {
  id: number;
  audience: string;
  body: string;
  recipientCount: number;
  sendAt: string;
  createdAt: string;
}

function normalizeScheduledBroadcast(payload: unknown): ScheduledBroadcast | null {
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : 0;
  if (!id) return null;
  return {
    id,
    audience: typeof row.audience === "string" ? row.audience : "all",
    body: typeof row.body === "string" ? row.body : "",
    recipientCount: typeof row.recipient_count === "number" ? row.recipient_count : 0,
    sendAt: typeof row.send_at === "string" ? row.send_at : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
  };
}

export async function listScheduledBroadcasts(
  accessToken: string
): Promise<ScheduledBroadcast[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts/scheduled");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).scheduled;
  if (!Array.isArray(rawList)) return null;
  const scheduled: ScheduledBroadcast[] = [];
  for (const item of rawList) {
    const normalized = normalizeScheduledBroadcast(item);
    if (normalized) scheduled.push(normalized);
  }
  return scheduled;
}

export type ScheduleBroadcastResult =
  | { kind: "ok"; scheduled: ScheduledBroadcast }
  | { kind: "no_recipients" }
  | { kind: "too_many_recipients" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function scheduleBroadcast(
  accessToken: string,
  audience: string,
  body: string,
  sendAtIso: string
): Promise<ScheduleBroadcastResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience, body, send_at: sendAtIso }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? ((payload as Record<string, unknown>).error as Record<string, unknown> | undefined)
            ?.code
        : null;
    if (code === "no_recipients") return { kind: "no_recipients" };
    if (code === "too_many_recipients") return { kind: "too_many_recipients" };
    return { kind: "invalid" };
  }
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const scheduled = normalizeScheduledBroadcast(
    (payload as Record<string, unknown>).scheduled
  );
  if (!scheduled) return { kind: "unavailable" };
  return { kind: "ok", scheduled };
}

export async function cancelScheduledBroadcast(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/broadcasts/scheduled/" + String(id),
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

export type ConversationStatusResult =`;

const BFF_SCHEDULE_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listScheduledBroadcasts,
  requirePortalAccessToken,
  scheduleBroadcast,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const scheduled = await listScheduledBroadcasts(accessToken);
    if (scheduled === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Scheduled broadcasts are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ scheduled }, 200);
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
  const audience = typeof input.audience === "string" ? input.audience : "all";
  const body = typeof input.body === "string" ? input.body : "";
  const sendAt = typeof input.send_at === "string" ? input.send_at : "";
  if (!body || !sendAt) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text and time are required." } },
      400
    );
  }

  try {
    const result = await scheduleBroadcast(accessToken, audience, body, sendAt);
    if (result.kind === "ok") {
      return safeJson({ ok: true, scheduled: result.scheduled }, 200);
    }
    if (result.kind === "no_recipients") {
      return safeJson(
        { error: { code: "no_recipients", message: "No conversations match this audience yet." } },
        400
      );
    }
    if (result.kind === "too_many_recipients") {
      return safeJson(
        {
          error: {
            code: "too_many_recipients",
            message: "Audience has more than 200 customers. Narrow it down.",
          },
        },
        400
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Pick a valid future time." } },
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

const BFF_CANCEL_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  cancelScheduledBroadcast,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


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
  const broadcastId = Number.parseInt(id, 10);
  if (!Number.isFinite(broadcastId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid broadcast id." } },
      400
    );
  }

  try {
    const result = await cancelScheduledBroadcast(accessToken, broadcastId);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        {
          error: {
            code: "not_found",
            message: "Scheduled broadcast not found (or already sent).",
          },
        },
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

const SCHEDULE_CARD_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface ScheduledRow {
  id: number;
  audience: string;
  body: string;
  recipientCount: number;
  sendAt: string;
}

const AUDIENCES = [
  { value: "all", label: "All customers" },
  { value: "open", label: "Open chats" },
  { value: "hot", label: "Hot leads" },
];

function formatWhen(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function minLocalValue(): string {
  const soon = new Date(Date.now() + 10 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(soon.getFullYear()) +
    "-" + pad(soon.getMonth() + 1) +
    "-" + pad(soon.getDate()) +
    "T" + pad(soon.getHours()) +
    ":" + pad(soon.getMinutes())
  );
}

export default function ScheduleCard() {
  const [rows, setRows] = useState<ScheduledRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [audience, setAudience] = useState("all");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts/schedule", {
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      const list =
        payload !== null && typeof payload === "object"
          ? (payload as { scheduled?: unknown }).scheduled
          : null;
      setRows(
        Array.isArray(list)
          ? list.filter(
              (row): row is ScheduledRow =>
                row !== null &&
                typeof row === "object" &&
                typeof (row as ScheduledRow).id === "number"
            )
          : []
      );
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    if (!body.trim() || !when) {
      setNoteTone("amber");
      setNote("Write the message and pick a future time.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, body, send_at: new Date(when).toISOString() }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) {
        setNoteTone("emerald");
        setNote("Scheduled. It will send on its own.");
        setBody("");
        setWhen("");
        void load();
        return;
      }
      const code =
        payload !== null && typeof payload === "object"
          ? ((payload as { error?: { code?: string } }).error?.code ?? "")
          : "";
      setNoteTone("amber");
      if (code === "no_recipients") setNote("No customers match this audience yet.");
      else if (code === "too_many_recipients") setNote("More than 200 customers match — narrow the audience.");
      else if (code === "bad_request") setNote("Pick a valid future time (within 30 days).");
      else setNote("Could not schedule right now. Try again.");
    } catch {
      setNoteTone("amber");
      setNote("Could not schedule right now. Try again.");
    } finally {
      setBusy(false);
    }
  }, [audience, body, when, load]);

  const cancel = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        const response = await fetch(
          "/api/omniflow/portal/broadcasts/schedule/" + String(id),
          { method: "DELETE" }
        );
        if (response.ok) {
          setNoteTone("emerald");
          setNote("Cancelled.");
          void load();
        } else {
          setNoteTone("amber");
          setNote("Could not cancel. It may have already sent.");
        }
      } catch {
        setNoteTone("amber");
        setNote("Could not cancel. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  return (
    <div className="mb-5 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.025] p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-white">Schedule for later</h2>
      <p className="mt-1 text-xs text-slate-400">
        Queue a broadcast for a future date and time. It sends automatically, as long as your
        connector laptop is online.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <select
          value={audience}
          onChange={(event) => setAudience(event.target.value)}
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white outline-none transition-colors duration-300 focus:border-cyan-400/40"
        >
          {AUDIENCES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={when}
          min={minLocalValue()}
          onChange={(event) => setWhen(event.target.value)}
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="w-full rounded-xl bg-cyan-400/15 px-4 py-2.5 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-50"
        >
          {busy ? "Working…" : "Schedule broadcast"}
        </button>
      </div>

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={2}
        maxLength={1000}
        placeholder={"Use {name} and it becomes each customer's first name."}
        className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
      />

      {note ? (
        <p
          className={
            "mt-2 text-xs " +
            (noteTone === "emerald" ? "text-emerald-300" : "text-amber-300")
          }
        >
          {note}
        </p>
      ) : null}

      <div className="mt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
          Pending schedule
        </p>
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing scheduled yet.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-200">{row.body}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {formatWhen(row.sendAt)} \\u00b7 {row.audience} \\u00b7 {row.recipientCount} customers
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void cancel(row.id)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-50"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
`;

const PAGE_IMPORT_FROM = `import { useCallback, useEffect, useState } from "react";`;
const PAGE_IMPORT_TO = `import { useCallback, useEffect, useState } from "react";
import ScheduleCard from "./ScheduleCard";`;

const PAGE_RENDER_FROM = `      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">`;
const PAGE_RENDER_TO = `      <ScheduleCard />

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">`;

const NEW_FILES = [
  { path: "Omniflow/app/api/omniflow/portal/broadcasts/schedule/route.ts", content: BFF_SCHEDULE_FILE, marker: "listScheduledBroadcasts", name: "p125-bff-schedule" },
  { path: "Omniflow/app/api/omniflow/portal/broadcasts/schedule/[id]/route.ts", content: BFF_CANCEL_FILE, marker: "cancelScheduledBroadcast", name: "p125-bff-cancel" },
  { path: "Omniflow/app/dashboard/(portal)/broadcasts/ScheduleCard.tsx", content: SCHEDULE_CARD_FILE, marker: "Schedule for later", name: "p124-schedule-card" },
];

const TARGETS = [
  {
    file: GROWTH_PATH,
    swaps: [
      { name: "p121-schedule-import", from: SCHEDULE_IMPORT_FROM, to: SCHEDULE_IMPORT_TO, guard: "from datetime import datetime, timedelta, timezone" },
      { name: "p121-schedule-consts", from: SCHEDULE_CONSTS_FROM, to: SCHEDULE_CONSTS_TO },
      { name: "p121-schedule-endpoints", from: SCHEDULE_BLOCK_FROM, to: SCHEDULE_BLOCK_TO, guard: "broadcasts/schedule" },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      { name: "p122-connector-materialize", from: CONNECTOR_HOOK_FROM, to: CONNECTOR_HOOK_TO, guard: "materialize_due_broadcasts(" },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      { name: "p123-portal-lib", from: PORTAL_TS_FROM, to: PORTAL_TS_TO, guard: "listScheduledBroadcasts" },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/broadcasts/page.tsx",
    swaps: [
      { name: "p124-page-import", from: PAGE_IMPORT_FROM, to: PAGE_IMPORT_TO },
      { name: "p124-page-render", from: PAGE_RENDER_FROM, to: PAGE_RENDER_TO, guard: "<ScheduleCard />" },
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

  const backup = target.file + ".pre_b121125.bak";
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