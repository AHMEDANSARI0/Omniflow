// add_batch_126_130.mjs - one-file batch covering Phases 126-130.
//
//   Ph126  NEW control-plane module portal_cod.py: COD confirmation flow
//          for cash-on-delivery orders (the #1 RTO reducer in PK commerce).
//          GET/PUT /portal/cod/settings (enabled + template with {name}),
//          GET /portal/cod/requests?status=. Lazy DDL for
//          portal_cod_settings + portal_cod_requests. Registered in app.py.
//   Ph127  Ingest hook: on an INBOUND message from a HOT lead (the laptop's
//          existing purchase-intent scoring), when enabled and outside the
//          24h per-conversation cooldown, the confirm template is queued
//          through the EXISTING connector command queue and a pending
//          request row is recorded. Customer replies YES/NO (English or
//          Roman Urdu) within 72h and the request flips to confirmed or
//          declined. Zero AI, zero bridge changes.
//   Ph128  portal lib: CodSettings + CodRequest + get/save/list clients.
//   Ph129  BFF routes (portal/cod, portal/cod/requests) + sidebar nav item
//          via a bounds-based inserter (anchor label fallbacks: Broadcasts
//          -> Business profile -> Conversations; per the earlier lesson
//          that nav arrays differ between trees).
//   Ph130  NEW page /dashboard/cod: settings card + request list with
//          status chips, filter tabs and empty states. Mobile responsive.
//
// Touches both repos. Vercel deploys on push; no restart, no new tables
// beyond the two lazy ones.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const COD_MODULE = `"""COD order confirmations: hot leads get one confirm ask, replies are parsed."""

import logging
import re
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth

bp = Blueprint("portal_cod", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

COD_SETTINGS_TABLE = "portal_cod_settings"
COD_REQUESTS_TABLE = "portal_cod_requests"
COD_MAX_TEMPLATE = 1000
COD_COOLDOWN_HOURS = 24
COD_REPLY_WINDOW_HOURS = 72

_DEFAULT_TEMPLATE = (
    "Thank you {name}! Your COD order is noted. Reply YES to confirm "
    "or NO to cancel."
)

_YES_RE = re.compile(
    r"^\\s*(yes|y|haan|han|ha|ji|jee|confirm|confirmed|ok|okay|theek|thik"
    r"|krdo|kar do|kardo|done|bolo|pack)\\b",
    re.IGNORECASE,
)
_NO_RE = re.compile(
    r"^\\s*(no|n|nahi|nahin|nhe|cancel|cancle|not needed|mat|wapas)\\b",
    re.IGNORECASE,
)

_COD_DDL_READY = False


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


def _ensure_cod_tables(conn) -> None:
    global _COD_DDL_READY
    if _COD_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(COD_SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " template TEXT NOT NULL DEFAULT '',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(COD_REQUESTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " conversation_id BIGINT,"
            " contact_id TEXT NOT NULL,"
            " contact_name TEXT,"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " template_sent TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " answered_at TIMESTAMPTZ)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_cod_requests"
            " ON " + portal_db._q(COD_REQUESTS_TABLE) +
            " (client_id, status, id DESC)"
        )
    conn.commit()
    _COD_DDL_READY = True


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _settings_public(row: Dict[str, Any]) -> dict:
    return {
        "enabled": bool(row.get("enabled")),
        "template": row.get("template") or _DEFAULT_TEMPLATE,
    }


def _request_public(row: Dict[str, Any]) -> dict:
    return {
        "id": row.get("id"),
        "conversation_id": row.get("conversation_id"),
        "contact_id": row.get("contact_id"),
        "contact_name": row.get("contact_name"),
        "status": row.get("status") or "pending",
        "created_at": _iso(row.get("created_at")),
        "answered_at": _iso(row.get("answered_at")),
    }


@bp.get("/cod/settings")
def get_cod_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cod_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT enabled, template FROM " + portal_db._q(COD_SETTINGS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("cod settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "cod settings read")[0]), 503
    return jsonify({"settings": _settings_public(found[0] if found else {})}), 200


@bp.put("/cod/settings")
def save_cod_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "enabled must be true or false."}}), 400
    template = str(payload.get("template") or "").strip()
    if not template:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Template text is required."}}), 400
    if len(template) > COD_MAX_TEMPLATE:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Template must be "
                                  + str(COD_MAX_TEMPLATE) + " characters or fewer."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cod_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(COD_SETTINGS_TABLE) +
                    " (client_id, enabled, template, updated_at)"
                    " VALUES (%s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE"
                    " SET enabled = EXCLUDED.enabled,"
                    " template = EXCLUDED.template,"
                    " updated_at = NOW()",
                    (principal["client_id"], enabled, template),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "cod settings save")[0]), 503
    return jsonify({"ok": True, "settings": {"enabled": enabled, "template": template}}), 200


@bp.get("/cod/requests")
def list_cod_requests():
    principal, error = _principal_or_error()
    if error:
        return error
    status_filter = (request.args.get("status") or "all").strip().lower()
    if status_filter not in ("all", "pending", "confirmed", "declined"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status all|pending|confirmed|declined hon."}}), 400
    where = " WHERE client_id = %s"
    params: list = [principal["client_id"]]
    if status_filter != "all":
        where += " AND status = %s"
        params.append(status_filter)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cod_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, conversation_id, contact_id, contact_name, status,"
                    " created_at, answered_at FROM " + portal_db._q(COD_REQUESTS_TABLE) +
                    where + " ORDER BY id DESC LIMIT 50",
                    tuple(params),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "cod requests read")[0]), 503
    counts = {"pending": 0, "confirmed": 0, "declined": 0}
    for row in found:
        key = row.get("status") if row.get("status") in counts else None
        if key:
            counts[key] += 1
    return jsonify({"requests": [_request_public(row) for row in found],
                    "counts": counts}), 200


def _send_cod_message(cur, client_id, contact_id, display_name, body, request_id):
    """Queue the confirm ask through the shared connector command helper."""
    portal_growth._send_command(
        cur, client_id, contact_id, display_name, body,
        "cod_confirm", broadcast_id=None,
    )


def maybe_cod_flow(client_id, conversation_id, contact_id, contact_name,
                   body, direction, conn) -> None:
    """Ingest hook: ask hot leads to confirm COD orders, parse their reply."""
    if direction != "in":
        return
    text = str(body or "").strip()
    if not text:
        return
    portal_db.ensure_tables()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT enabled, template FROM " + portal_db._q(COD_SETTINGS_TABLE) +
            " WHERE client_id = %s",
            (client_id,),
        )
        found = portal_db.rows(cur)
        settings = found[0] if found else {}
        if not settings.get("enabled"):
            return
        cur.execute(
            "SELECT id, status FROM " + portal_db._q(COD_REQUESTS_TABLE) +
            " WHERE client_id = %s AND conversation_id = %s"
            " AND status = 'pending'"
            " AND created_at > NOW() - make_interval(hours => %s)"
            " ORDER BY id DESC LIMIT 1",
            (client_id, conversation_id, COD_REPLY_WINDOW_HOURS),
        )
        pending = portal_db.rows(cur)
        if pending:
            request_id = int(pending[0].get("id") or 0)
            if _NO_RE.match(text):
                new_status = "declined"
            elif _YES_RE.match(text):
                new_status = "confirmed"
            else:
                return
            cur.execute(
                "UPDATE " + portal_db._q(COD_REQUESTS_TABLE) +
                " SET status = %s, answered_at = NOW()"
                " WHERE id = %s AND status = 'pending'",
                (new_status, request_id),
            )
            portal_db.log_action(
                cur,
                client_id,
                "cod." + new_status,
                "customer",
                None,
                conversation_id,
                "COD request " + str(request_id) + " replied " + new_status + ".",
            )
            return
        cur.execute(
            " SELECT 1 FROM " + portal_db._q(portal_db.CONV_TABLE) +
            " c WHERE c.id = %s AND c.client_id = %s"
            " AND c.lead_temp = 'hot'"
            " AND NOT EXISTS ("
            " SELECT 1 FROM " + portal_db._q(COD_REQUESTS_TABLE) +
            " cr WHERE cr.conversation_id = c.id"
            " AND cr.created_at > NOW() - make_interval(hours => %s))"
            " LIMIT 1",
            (conversation_id, client_id, COD_COOLDOWN_HOURS),
        )
        eligible = portal_db.rows(cur)
        if not eligible:
            return
        display = str(contact_name or "").strip()
        rendered = str(settings.get("template") or _DEFAULT_TEMPLATE).replace(
            "{name}", (display.split(" ")[0] if display else "there")
        )
        cur.execute(
            "INSERT INTO " + portal_db._q(COD_REQUESTS_TABLE) +
            " (client_id, conversation_id, contact_id, contact_name,"
            " status, template_sent)"
            " VALUES (%s, %s, %s, %s, 'pending', %s)"
            " RETURNING id",
            (client_id, conversation_id, str(contact_id or ""), display, rendered),
        )
        created = portal_db.rows(cur)
        request_id = int((created[0] if created else {}).get("id") or 0)
        _send_cod_message(cur, client_id, str(contact_id or ""), display,
                          rendered, request_id)
        portal_db.log_action(
            cur,
            client_id,
            "cod.confirm_sent",
            "automation",
            None,
            conversation_id,
            "COD confirmation asked (" + str(request_id) + ").",
        )
`;

const APP_IMPORT_FROM = `from portal_growth import bp as portal_growth_bp  # noqa: E402`;
const APP_IMPORT_TO = `from portal_growth import bp as portal_growth_bp  # noqa: E402
from portal_cod import bp as portal_cod_bp  # noqa: E402`;

const APP_REGISTER_FROM = `aux_app.register_blueprint(portal_growth_bp)`;
const APP_REGISTER_TO = `aux_app.register_blueprint(portal_growth_bp)
aux_app.register_blueprint(portal_cod_bp)`;

const COD_HOOK_FROM = `                    except Exception:
                        pass
                    inserted += 1`;

const COD_HOOK_TO = `                    except Exception:
                        pass
                    try:
                        portal_cod.maybe_cod_flow(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["body"],
                            item["direction"],
                            conn,
                        )
                    except Exception:
                        pass
                    inserted += 1`;

const COD_CONNECTOR_IMPORT_FROM = `import portal_db

`;

const COD_CONNECTOR_IMPORT_TO = `import portal_db
import portal_cod

`;

const PORTAL_TS_FROM = `export type ConversationStatusResult =`;

const PORTAL_TS_TO = `export interface CodSettings {
  enabled: boolean;
  template: string;
}

export interface CodRequest {
  id: number;
  conversationId: number | null;
  contactId: string;
  contactName: string | null;
  status: "pending" | "confirmed" | "declined";
  createdAt: string;
  answeredAt: string | null;
}

export async function getCodSettings(
  accessToken: string
): Promise<CodSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cod/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).settings;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    template: typeof row.template === "string" ? row.template : "",
  };
}

export async function saveCodSettings(
  accessToken: string,
  settings: CodSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cod/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: settings.enabled, template: settings.template }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

function normalizeCodRequest(payload: unknown): CodRequest | null {
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : 0;
  if (!id) return null;
  const status =
    row.status === "confirmed" || row.status === "declined" ? row.status : "pending";
  return {
    id,
    conversationId: typeof row.conversation_id === "number" ? row.conversation_id : null,
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    contactName: typeof row.contact_name === "string" ? row.contact_name : null,
    status,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    answeredAt: typeof row.answered_at === "string" ? row.answered_at : null,
  };
}

export async function listCodRequests(
  accessToken: string,
  status: "all" | "pending" | "confirmed" | "declined"
): Promise<{ requests: CodRequest[]; counts: Record<string, number> } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/cod/requests?status=" + encodeURIComponent(status)
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
  const p = payload as Record<string, unknown>;
  const rawList = p.requests;
  if (!Array.isArray(rawList)) return null;
  const requests: CodRequest[] = [];
  for (const item of rawList) {
    const normalized = normalizeCodRequest(item);
    if (normalized) requests.push(normalized);
  }
  const counts =
    p.counts !== null && typeof p.counts === "object"
      ? (p.counts as Record<string, unknown>)
      : {};
  const safeCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") safeCounts[key] = value;
  }
  return { requests, counts: safeCounts };
}

export type ConversationStatusResult =`;

const BFF_SETTINGS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getCodSettings,
  requirePortalAccessToken,
  saveCodSettings,
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
    const settings = await getCodSettings(accessToken);
    if (settings === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "COD confirmations are not available yet.",
          },
        },
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

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const template = typeof input.template === "string" ? input.template.trim() : "";
  const enabled = input.enabled === true;
  if (!template) {
    return safeJson(
      { error: { code: "bad_request", message: "Template text is required." } },
      400
    );
  }

  try {
    const ok = await saveCodSettings(accessToken, { enabled, template });
    if (ok) {
      return safeJson({ ok: true, settings: { enabled, template } }, 200);
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

const BFF_REQUESTS_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listCodRequests,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";

const ALLOWED = new Set(["all", "pending", "confirmed", "declined"]);


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  let status = "all";
  try {
    const raw = new URL(request.url).searchParams.get("status");
    if (raw && ALLOWED.has(raw)) status = raw;
  } catch {
    status = "all";
  }

  try {
    const result = await listCodRequests(
      accessToken,
      status as "all" | "pending" | "confirmed" | "declined"
    );
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "COD confirmations are not available yet.",
          },
        },
        503
      );
    }
    return safeJson(result, 200);
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

const COD_PAGE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface Settings {
  enabled: boolean;
  template: string;
}

interface CodRow {
  id: number;
  conversationId: number | null;
  contactName: string | null;
  contactId: string;
  status: "pending" | "confirmed" | "declined";
  createdAt: string;
  answeredAt: string | null;
}

const FILTERS = ["all", "pending", "confirmed", "declined"] as const;

const STATUS_STYLES: Record<string, string> = {
  pending: "border-amber-400/25 bg-amber-400/[0.07] text-amber-300",
  confirmed: "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-300",
  declined: "border-rose-400/25 bg-rose-400/[0.07] text-rose-300",
};

function formatWhen(value: string): string {
  if (!value) return "\\u2014";
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

export default function CodPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [template, setTemplate] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [requests, setRequests] = useState<CodRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loadError, setLoadError] = useState(false);

  const loadRequests = useCallback(async (which: string) => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/cod/requests?status=" + which,
        { cache: "no-store" }
      );
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const p = payload as { requests?: unknown; counts?: unknown };
        setRequests(Array.isArray(p.requests) ? (p.requests as CodRow[]) : []);
        setCounts(
          p.counts !== null && typeof p.counts === "object"
            ? (p.counts as Record<string, number>)
            : {}
        );
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/omniflow/portal/cod", {
          cache: "no-store",
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!cancelled && payload !== null && typeof payload === "object") {
          const raw = (payload as { settings?: Settings }).settings;
          if (raw) {
            setSettings(raw);
            setEnabled(raw.enabled);
            setTemplate(raw.template);
          } else {
            setLoadError(true);
          }
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadRequests(filter);
  }, [filter, loadRequests]);

  const save = useCallback(async () => {
    if (!template.trim()) {
      setNote("Write the confirmation message first.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/cod", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, template }),
      });
      if (response.ok) {
        setNote(enabled ? "Saved. COD confirmations are ON." : "Saved. COD confirmations are off.");
      } else {
        setNote("Could not save. Check the message length (1000 max).");
      }
    } catch {
      setNote("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }, [enabled, template]);

  const chipCount = (key: string) => (typeof counts[key] === "number" ? counts[key] : 0);

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">COD confirmations</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Hot leads get one confirmation ask automatically; their YES or NO reply is
            recorded here so delivered orders (and returns) stay visible.
          </p>
        </div>

        {loadError ? (
          <p className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-300">
            COD confirmations are unavailable right now.
          </p>
        ) : null}

        <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium text-white">Ask for confirmation</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Sends once per customer per 24 hours, only when a chat is marked as a hot lead.
              </span>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-5 w-5 shrink-0 accent-cyan-400"
            />
          </label>

          <textarea
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            rows={3}
            maxLength={1000}
            className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
            placeholder={"Use {name} and it becomes each customer's first name."}
          />
          <p className="mt-1 text-[11px] text-slate-600">
            Customer replies YES or NO (English or Roman Urdu both work).
          </p>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || loading}
              className="rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {busy ? "Saving\\u2026" : "Save settings"}
            </button>
            {note ? <p className="text-xs text-slate-400">{note}</p> : null}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={
                "rounded-full px-3 py-1 text-xs font-medium capitalize transition " +
                (filter === option
                  ? "bg-cyan-400/15 text-cyan-300"
                  : "text-slate-400 hover:text-slate-200")
              }
            >
              {option} ({option === "all" ? requests.length : chipCount(option)})
            </button>
          ))}
        </div>

        {requests.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-8 text-center">
            <p className="text-sm text-slate-400">No COD requests in this view yet.</p>
            <p className="mt-1 text-xs text-slate-600">
              Turn the ask on above; hot leads will be asked on their next message.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {requests.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-2xl border border-white/[0.06] bg-white/[0.015] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-200">
                    {row.contactName || row.contactId}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Asked {formatWhen(row.createdAt)}
                    {row.answeredAt ? " \\u00b7 replied " + formatWhen(row.answeredAt) : ""}
                  </p>
                </div>
                <span
                  className={
                    "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize " +
                    (STATUS_STYLES[row.status] ?? STATUS_STYLES.pending)
                  }
                >
                  {row.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
`;

const NAV_PATH = "Omniflow/app/dashboard/components/DashSidebar.tsx";
const NAV_ITEM = '{ label: "COD confirmations", href: "/dashboard/cod", icon: "\\u25a4", enabled: true }';

function insertNavItem(text) {
  if (text.includes('label: "COD confirmations"')) {
    return { text, changed: false, anchor: "already" };
  }
  for (const anchorLabel of ["Broadcasts", "Business profile", "Conversations"]) {
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
  { path: "OmniFlow-Control-Plane/portal_cod.py", content: COD_MODULE, marker: "maybe_cod_flow", name: "p126-cod-module" },
  { path: "Omniflow/app/api/omniflow/portal/cod/route.ts", content: BFF_SETTINGS_FILE, marker: "getCodSettings", name: "p129-bff-cod" },
  { path: "Omniflow/app/api/omniflow/portal/cod/requests/route.ts", content: BFF_REQUESTS_FILE, marker: "listCodRequests", name: "p129-bff-cod-requests" },
  { path: "Omniflow/app/dashboard/(portal)/cod/page.tsx", content: COD_PAGE, marker: "COD confirmations", name: "p130-cod-page" },
];

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      { name: "p126-app-import", from: APP_IMPORT_FROM, to: APP_IMPORT_TO, guard: "portal_cod" },
      { name: "p126-app-register", from: APP_REGISTER_FROM, to: APP_REGISTER_TO, guard: "register_blueprint(portal_cod_bp)" },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      { name: "p127-connector-import", from: COD_CONNECTOR_IMPORT_FROM, to: COD_CONNECTOR_IMPORT_TO, guard: "\nimport portal_cod\n" },
      { name: "p127-cod-hook", from: COD_HOOK_FROM, to: COD_HOOK_TO, guard: "maybe_cod_flow(" },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      { name: "p128-portal-lib", from: PORTAL_TS_FROM, to: PORTAL_TS_TO, guard: "listCodRequests" },
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

  const backup = target.file + ".pre_b126130.bak";
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

// Sidebar nav item: bounds-based (nav arrays differ between trees).

if (fs.existsSync(NAV_PATH)) {
  const navOriginal = fs.readFileSync(NAV_PATH, "utf8");
  const navResult = insertNavItem(navOriginal.replace(/\r\n/g, "\n"));
  if (navResult.anchor === "already") {
    alreadyTotal++;
    console.log("= " + NAV_PATH + " (nav item already present)");
  } else if (navResult.anchor === null) {
    warnTotal++;
    console.log("  ? " + NAV_PATH + " :: p130-nav-item NOT FOUND — paste the navItems block");
  } else {
    const navBackup = NAV_PATH + ".pre_b126130.bak";
    if (!fs.existsSync(navBackup)) fs.copyFileSync(NAV_PATH, navBackup);
    fs.writeFileSync(NAV_PATH, navResult.text, "utf8");
    appliedTotal++;
    console.log("+ " + NAV_PATH + " (1): p130-nav-item after " + navResult.anchor);
  }
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + NAV_PATH);
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