// add_analytics.mjs — Phase 6: Analytics v0 (zero AI cost).
//
// A read-only Analytics page for the portal: customer/conversation/message
// totals, a zero-filled per-day inbound/outbound chart (7, 14 or 30 days),
// intent breakdown, automation counters (instant answers, follow-up
// deliveries, queued replies) and top knowledge-base entries. Everything is
// computed with SQL aggregates over EXISTING tables — no schema changes,
// no migration, no bridge changes, no bot restart.
//
// Backend : portal_analytics.py (GET /portal/analytics), app.py blueprint.
// Website : portal.ts helpers, BFF analytics route, Analytics page +
//           range-switching client, sidebar: Analytics link + every
//           remaining nav item enabled (all pages are live).
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_analytics.mjs
//
// Requires Phase 5 (add_business_core.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_an.bak

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_analytics.py";
const BFF_ANALYTICS_PATH = "Omniflow/app/api/omniflow/portal/analytics/route.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/analytics/page.tsx";
const CLIENT_PATH =
  "Omniflow/app/dashboard/(portal)/analytics/AnalyticsClient.tsx";

const MODULE_FILE = `"""Portal analytics (customer Bearer, read-only aggregates).

Read-only rollups over conversations, messages, the action audit log and
knowledge-base usage. Everything is computed with SQL aggregates for the
requested window (7, 14 or 30 days); per-day buckets are zero-filled in UTC
so the UI always renders a continuous chart. Deterministic: zero AI cost.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import logging

from flask import Blueprint, jsonify, request

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db


logger = logging.getLogger("omniflow.portal-analytics")

bp = Blueprint("portal_analytics", __name__, url_prefix="/api/v1")

ALLOWED_WINDOWS = (7, 14, 30)

AUTOMATION_ACTIONS = ("kb.auto_reply", "message.enqueued", "followup.ack")
FOLLOWUP_DELIVERED_PREFIX = "Follow-up delivered%"


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


def _direction_counts(rows) -> Dict[str, int]:
    counts = {"in": 0, "out": 0}
    for row in rows:
        direction = str(row.get("direction") or "")
        if direction in counts:
            counts[direction] = int(row.get("c") or 0)
    return counts


@bp.get("/portal/analytics")
def get_analytics():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    raw_days = (request.args.get("days") or "7").strip()
    try:
        days = int(raw_days)
    except (TypeError, ValueError):
        days = 7
    if days not in ALLOWED_WINDOWS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be 7, 14 or 30."}}), 400
    client_id = principal["client_id"]

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS conversations,"
                    " COUNT(*) FILTER (WHERE status = 'closed')"
                    " AS conversations_closed,"
                    " COUNT(DISTINCT contact_id) AS customers"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s",
                    (client_id,),
                )
                totals_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT direction, COUNT(*) AS c FROM "
                    + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE client_id = %s GROUP BY direction",
                    (client_id,),
                )
                direction_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT COUNT(*) AS c FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s"
                    " AND created_at > NOW() - make_interval(days => %s)",
                    (client_id, days),
                )
                window_conv_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT created_at::date AS day, direction, COUNT(*) AS c"
                    " FROM " + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE client_id = %s"
                    " AND created_at > NOW() - make_interval(days => %s)"
                    " GROUP BY 1, 2",
                    (client_id, days),
                )
                per_day_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT intent, COUNT(*) AS c FROM "
                    + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE client_id = %s AND direction = 'in'"
                    " AND intent IS NOT NULL"
                    " AND created_at > NOW() - make_interval(days => %s)"
                    " GROUP BY intent ORDER BY COUNT(*) DESC LIMIT 8",
                    (client_id, days),
                )
                intent_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT action, COUNT(*) AS c FROM "
                    + portal_db._q("portal_action_log") +
                    " WHERE client_id = %s"
                    " AND created_at > NOW() - make_interval(days => %s)"
                    " AND action IN %s"
                    " GROUP BY action",
                    (client_id, days, AUTOMATION_ACTIONS),
                )
                automation_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT COUNT(*) AS c FROM "
                    + portal_db._q("portal_action_log") +
                    " WHERE client_id = %s AND action = 'followup.ack'"
                    " AND note LIKE %s"
                    " AND created_at > NOW() - make_interval(days => %s)",
                    (client_id, FOLLOWUP_DELIVERED_PREFIX, days),
                )
                delivered_rows = portal_db.rows(cur)

                cur.execute(
                    "SELECT title, usage_count FROM "
                    + portal_db._q("portal_kb_entries") +
                    " WHERE client_id = %s AND usage_count > 0"
                    " ORDER BY usage_count DESC, updated_at DESC LIMIT 5",
                    (client_id,),
                )
                entry_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal analytics")[0]), 503

    totals_row = totals_rows[0] if totals_rows else {}
    all_time = _direction_counts(direction_rows)
    window_conversations = int(
        (window_conv_rows[0].get("c") if window_conv_rows else 0) or 0
    )

    # Zero-filled UTC day buckets so the chart is continuous.
    today = datetime.now(timezone.utc).date()
    buckets: Dict[str, Dict[str, int]] = {}
    day_order: List[str] = []
    for offset in range(days - 1, -1, -1):
        key = (today - timedelta(days=offset)).isoformat()
        buckets[key] = {"inbound": 0, "outbound": 0}
        day_order.append(key)
    for row in per_day_rows:
        key = str(row.get("day") or "")
        if key in buckets:
            direction = str(row.get("direction") or "in")
            field = "outbound" if direction == "out" else "inbound"
            buckets[key][field] = int(row.get("c") or 0)
    per_day = [
        {"day": key, "inbound": buckets[key]["inbound"],
         "outbound": buckets[key]["outbound"]}
        for key in day_order
    ]
    window_in = sum(item["inbound"] for item in per_day)
    window_out = sum(item["outbound"] for item in per_day)

    automation = {
        str(row.get("action") or ""): int(row.get("c") or 0)
        for row in automation_rows
    }
    delivered = int((delivered_rows[0].get("c") if delivered_rows else 0) or 0)

    intents = [
        {"intent": str(row.get("intent") or ""), "count": int(row.get("c") or 0)}
        for row in intent_rows
    ]
    top_entries = [
        {"title": str(row.get("title") or ""),
         "usage_count": int(row.get("usage_count") or 0)}
        for row in entry_rows
    ]

    return jsonify({
        "days": days,
        "totals": {
            "conversations": int(totals_row.get("conversations") or 0),
            "conversations_closed": int(
                totals_row.get("conversations_closed") or 0
            ),
            "customers": int(totals_row.get("customers") or 0),
            "messages_in": all_time["in"],
            "messages_out": all_time["out"],
        },
        "window": {
            "conversations": window_conversations,
            "messages_in": window_in,
            "messages_out": window_out,
            "instant_answers": automation.get("kb.auto_reply", 0),
            "followups_delivered": delivered,
            "replies_queued": automation.get("message.enqueued", 0),
        },
        "per_day": per_day,
        "intents": intents,
        "top_entries": top_entries,
    }), 200
`;

const BFF_ANALYTICS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getAnalytics,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const requested = new URL(request.url).searchParams.get("days");
  const path =
    "api/v1/portal/analytics" +
    (requested ? "?days=" + encodeURIComponent(requested) : "");

  try {
    const data = await getAnalytics(accessToken, path);
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
`;

const PAGE_FILE = `import { getAnalytics } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import AnalyticsClient from "./AnalyticsClient";


export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { accessToken } = await readSessionCookies();
  const data = accessToken ? await getAnalytics(accessToken) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Analytics
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          How your assistant is performing — conversations, messages,
          automation and the questions customers actually ask.
        </p>
      </div>

      {data === null ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
          <p className="text-xs leading-relaxed text-slate-500">
            Analytics is rolling out on the server — try again shortly after
            the deploy finishes.
          </p>
        </div>
      ) : (
        <AnalyticsClient initial={data} />
      )}
    </div>
  );
}
`;

const CLIENT_FILE = `"use client";

import { useCallback, useState } from "react";
import type { AnalyticsData } from "../../../../lib/omniflow/portal";

const statClass =
  "rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-4";

const statLabel = "text-[10px] uppercase tracking-wider text-slate-600";
const statValue = "mt-1 text-lg font-semibold text-white";

const chipBtn =
  "rounded-xl border px-3.5 py-1.5 text-xs font-medium transition-colors duration-300";

function intentLabel(intent: string): string {
  return intent.charAt(0).toUpperCase() + intent.slice(1).replace(/_/g, " ");
}

export default function AnalyticsClient({
  initial,
}: {
  initial: AnalyticsData;
}) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/analytics?days=" + String(days),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as
        | (AnalyticsData & { error?: unknown })
        | null;
      if (payload && payload.totals && Array.isArray(payload.perDay)) {
        setData(payload);
      }
    } catch {
      // Keep showing the previous window on transient failures.
    } finally {
      setLoading(false);
    }
  }, []);

  const totals = data.totals;
  const window = data.window;
  const maxDay = Math.max(
    1,
    ...data.perDay.map((point) => point.inbound + point.outbound)
  );
  const maxIntent = Math.max(1, ...data.intents.map((item) => item.count));
  const dayLabelStep = data.perDay.length > 14 ? 5 : data.perDay.length > 7 ? 3 : 1;
  const isEmpty =
    totals.conversations === 0 &&
    totals.messagesIn === 0 &&
    totals.messagesOut === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 14, 30].map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => load(days)}
            disabled={loading}
            className={
              chipBtn +
              " " +
              (data.days === days
                ? "border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:bg-white/[0.05]") +
              (loading ? " opacity-50" : "")
            }
          >
            {days === data.days ? "Last " : ""}
            {days} days
          </button>
        ))}
      </div>

      {isEmpty ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-8 text-center">
          <p className="text-sm text-slate-400">No data yet</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            Numbers appear here automatically as customers start chatting on
            WhatsApp.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className={statClass}>
              <p className={statLabel}>Customers</p>
              <p className={statValue}>{totals.customers}</p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Conversations</p>
              <p className={statValue}>{totals.conversations}</p>
              <p className="text-[10px] text-slate-600">
                {totals.conversationsClosed} closed
              </p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Messages in</p>
              <p className={statValue}>{totals.messagesIn}</p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Messages out</p>
              <p className={statValue}>{totals.messagesOut}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Messages per day
              </h2>
              <div className="flex items-center gap-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-cyan-400" /> In
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" /> Out
                </span>
              </div>
            </div>
            <div className="mt-5 flex h-32 items-end gap-1">
              {data.perDay.map((point) => {
                const total = point.inbound + point.outbound;
                const heightPct = Math.round((total / maxDay) * 100);
                const inboundPct =
                  total === 0 ? 0 : Math.round((point.inbound / total) * 100);
                return (
                  <div
                    key={point.day}
                    title={point.day + " — in " + point.inbound + ", out " + point.outbound}
                    className="flex h-full flex-1 flex-col justify-end"
                  >
                    <div
                      className="flex w-full flex-col justify-end overflow-hidden rounded-t-md"
                      style={{ height: Math.max(total === 0 ? 2 : 6, heightPct) + "%" }}
                    >
                      <div
                        className="w-full bg-emerald-400/80"
                        style={{ height: String(100 - inboundPct) + "%" }}
                      />
                      <div
                        className="w-full bg-cyan-400/80"
                        style={{ height: String(inboundPct) + "%" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex gap-1">
              {data.perDay.map((point, index) => (
                <div key={point.day} className="flex-1 text-center">
                  {index % dayLabelStep === 0 ? (
                    <span className="text-[9px] text-slate-600">
                      {point.day.slice(8)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className={statClass}>
              <p className={statLabel}>Instant answers</p>
              <p className={statValue}>{window.instantAnswers}</p>
              <p className="text-[10px] text-slate-600">
                Knowledge-base replies
              </p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Follow-ups delivered</p>
              <p className={statValue}>{window.followupsDelivered}</p>
              <p className="text-[10px] text-slate-600">
                After customers went silent
              </p>
            </div>
            <div className={statClass}>
              <p className={statLabel}>Replies queued</p>
              <p className={statValue}>{window.repliesQueued}</p>
              <p className="text-[10px] text-slate-600">Manual team replies</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
            <h2 className="text-sm font-semibold text-white">
              What customers ask about
            </h2>
            {data.intents.length === 0 ? (
              <p className="mt-3 text-xs text-slate-600">
                No classified messages in this window yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {data.intents.map((item) => (
                  <li key={item.intent}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300">
                        {intentLabel(item.intent)}
                      </span>
                      <span className="text-slate-500">{item.count}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                      <div
                        className="h-full rounded-full bg-cyan-400/70"
                        style={{
                          width: Math.max(4, Math.round((item.count / maxIntent) * 100)) + "%",
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
            <h2 className="text-sm font-semibold text-white">
              Most-used answers
            </h2>
            {data.topEntries.length === 0 ? (
              <p className="mt-3 text-xs text-slate-600">
                No knowledge-base answers have been sent yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-2.5">
                {data.topEntries.map((entry) => (
                  <li
                    key={entry.title}
                    className="flex items-center justify-between gap-4 text-xs"
                  >
                    <span className="min-w-0 truncate text-slate-300">
                      {entry.title}
                    </span>
                    <span className="shrink-0 text-slate-500">
                      sent {entry.usageCount}{" "}
                      {entry.usageCount === 1 ? "time" : "times"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
`;

const TARGETS = [
  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import analytics blueprint",
        from: `from portal_catalog import bp as portal_catalog_bp  # noqa: E402`,
        to: `from portal_catalog import bp as portal_catalog_bp  # noqa: E402
from portal_analytics import bp as portal_analytics_bp  # noqa: E402`,
      },
      {
        name: "register analytics blueprint",
        from: `aux_app.register_blueprint(portal_catalog_bp)`,
        to: `aux_app.register_blueprint(portal_catalog_bp)
aux_app.register_blueprint(portal_analytics_bp)`,
      },
    ],
  },
  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "analytics client helpers",
        from: `export type ConversationStatusResult =`,
        to: `export interface AnalyticsTotals {
  conversations: number;
  conversationsClosed: number;
  customers: number;
  messagesIn: number;
  messagesOut: number;
}

export interface AnalyticsWindow {
  conversations: number;
  messagesIn: number;
  messagesOut: number;
  instantAnswers: number;
  followupsDelivered: number;
  repliesQueued: number;
}

export interface AnalyticsDayPoint {
  day: string;
  inbound: number;
  outbound: number;
}

export interface AnalyticsIntent {
  intent: string;
  count: number;
}

export interface AnalyticsTopEntry {
  title: string;
  usageCount: number;
}

export interface AnalyticsData {
  days: number;
  totals: AnalyticsTotals;
  window: AnalyticsWindow;
  perDay: AnalyticsDayPoint[];
  intents: AnalyticsIntent[];
  topEntries: AnalyticsTopEntry[];
}

export async function getAnalytics(
  accessToken: string,
  path = "api/v1/portal/analytics"
): Promise<AnalyticsData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path);
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawTotals = p.totals;
  const rawWindow = p.window;
  const rawPerDay = p.per_day;
  const rawIntents = p.intents;
  const rawTopEntries = p.top_entries;
  if (
    rawTotals === null || typeof rawTotals !== "object" ||
    rawWindow === null || typeof rawWindow !== "object" ||
    !Array.isArray(rawPerDay)
  ) {
    return null;
  }
  const t = rawTotals as Record<string, unknown>;
  const w = rawWindow as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    days: num(p.days) || 7,
    totals: {
      conversations: num(t.conversations),
      conversationsClosed: num(t.conversations_closed),
      customers: num(t.customers),
      messagesIn: num(t.messages_in),
      messagesOut: num(t.messages_out),
    },
    window: {
      conversations: num(w.conversations),
      messagesIn: num(w.messages_in),
      messagesOut: num(w.messages_out),
      instantAnswers: num(w.instant_answers),
      followupsDelivered: num(w.followups_delivered),
      repliesQueued: num(w.replies_queued),
    },
    perDay: rawPerDay
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        day: typeof raw.day === "string" ? raw.day : "",
        inbound: num(raw.inbound),
        outbound: num(raw.outbound),
      })),
    intents: Array.isArray(rawIntents)
      ? rawIntents
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map((raw) => ({
            intent: typeof raw.intent === "string" ? raw.intent : "",
            count: num(raw.count),
          }))
      : [],
    topEntries: Array.isArray(rawTopEntries)
      ? rawTopEntries
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map((raw) => ({
            title: typeof raw.title === "string" ? raw.title : "",
            usageCount: num(raw.usage_count),
          }))
      : [],
  };
}

export type ConversationStatusResult =`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "insert Analytics above Business profile",
        regex: '  \\{\n    label: "Business profile",\n    href: "/dashboard/profile",\n    icon: "◇",\n    enabled: (?:false|true),\n  \\},',
        flags: "",
        alreadyMarker: "/dashboard/analytics",
        to: `  {
    label: "Analytics",
    href: "/dashboard/analytics",
    icon: "◢",
    enabled: true,
  },
  {
    label: "Business profile",
    href: "/dashboard/profile",
    icon: "◇",
    enabled: true,
  },`,
      },
      {
        name: "enable WhatsApp setup link",
        from: `  {
    label: "WhatsApp setup",
    href: "/dashboard/channels/whatsapp",
    icon: "◉",
    enabled: false,
  },`,
        to: `  {
    label: "WhatsApp setup",
    href: "/dashboard/channels/whatsapp",
    icon: "◉",
    enabled: true,
  },`,
      },
      {
        name: "enable AI agents link",
        from: `  { label: "AI agents", href: "/dashboard/bot", icon: "✦", enabled: false },`,
        to: `  { label: "AI agents", href: "/dashboard/bot", icon: "✦", enabled: true },`,
      },
      {
        name: "enable Conversations link",
        from: `  {
    label: "Conversations",
    href: "/dashboard/conversations",
    icon: "◎",
    enabled: false,
  },`,
        to: `  {
    label: "Conversations",
    href: "/dashboard/conversations",
    icon: "◎",
    enabled: true,
  },`,
      },
      {
        name: "enable Settings link",
        from: `  { label: "Settings", href: "/dashboard/settings", icon: "⌘", enabled: false },`,
        to: `  { label: "Settings", href: "/dashboard/settings", icon: "⌘", enabled: true },`,
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

  const backup = target.file + ".pre_an.bak";
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
  [BFF_ANALYTICS_PATH, BFF_ANALYTICS_FILE],
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
