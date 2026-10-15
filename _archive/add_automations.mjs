// add_automations.mjs — Phase 17: Automations v0 (deterministic keyword rules).
//
// Zero AI, no bridge changes -> NO bot restart. Merchants define simple
// rules that run on every inbound message (WhatsApp + website):
//     when message contains "price"  -> add label "pricing"
//     when message contains "wholesale" -> assign to "ahmed@shop.com"
// 1. CP: portal_automations table (UNIQUE client+keyword+action+value, max 20
//    rules, active/inactive toggle, times_triggered counter), CRUD endpoints
//    (GET/POST/PATCH/DELETE /portal/automations, human-only writes, audit
//    automation.created/updated/deleted), and apply_automation_rules() hooked
//    into BOTH inbound paths: the connector ingest chain (WhatsApp) and the
//    website widget send. Tags respect the 6-label cap (INSERT ON CONFLICT
//    DO NOTHING); assignment never overrides a human (only fills NULL).
// 2. BFF: automations route + [id] route (PATCH toggle, DELETE).
// 3. UI: new Automations page (sidebar entry) — add rule form with keyword,
//    action select (Add label / Assign to team member), rules list with
//    fire counts, toggle and delete.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_automations.mjs
//
// Requires Phase 16 (add_customers_page.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_auto.bak
// Expected first run: 12 applied, 0 warnings (9 swaps + 3 new files).
// Expected rerun:     0 applied, 9 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_AUTOMATIONS_PATH =
  "Omniflow/app/api/omniflow/portal/automations/route.ts";
const BFF_AUTOMATION_ID_PATH =
  "Omniflow/app/api/omniflow/portal/automations/[id]/route.ts";
const AUTOMATIONS_PAGE_PATH =
  "Omniflow/app/dashboard/(portal)/automations/page.tsx";

const BFF_AUTOMATIONS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createAutomation,
  listAutomations,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listAutomations(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ automations: data }, 200);
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
    keyword?: unknown;
    actionType?: unknown;
    actionValue?: unknown;
  } | null;
  const keyword = typeof payload?.keyword === "string" ? payload.keyword : "";
  const actionType =
    payload?.actionType === "add_tag" || payload?.actionType === "assign"
      ? payload.actionType
      : "";
  const actionValue =
    typeof payload?.actionValue === "string" ? payload.actionValue : "";
  if (!keyword.trim() || !actionType || !actionValue.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Keyword, action and value are required." } },
      400
    );
  }

  try {
    const result = await createAutomation(
      accessToken,
      keyword,
      actionType,
      actionValue
    );
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
            message: "Keyword must be 2-40 characters; check the value too.",
          },
        },
        400
      );
    }
    if (result.kind === "assignee_not_found") {
      return safeJson(
        {
          error: {
            code: "assignee_not_found",
            message: "Assignee must be an active team member.",
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
            message: "A rule with this keyword and action already exists.",
          },
        },
        409
      );
    }
    if (result.kind === "limit_reached") {
      return safeJson(
        {
          error: { code: "limit_reached", message: "Up to 20 automations." },
        },
        409
      );
    }
    return safeJson({ ok: true, automation: result.automation }, 200);
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

const BFF_AUTOMATION_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteAutomation,
  requirePortalAccessToken,
  setAutomationActive,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveRuleId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) return null;
  return ruleId;
}

export async function PATCH(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const ruleId = await resolveRuleId(context);
  if (ruleId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid automation id." } },
      400
    );
  }
  const payload = (await request.json().catch(() => null)) as {
    isActive?: unknown;
  } | null;
  if (typeof payload?.isActive !== "boolean") {
    return safeJson(
      { error: { code: "bad_request", message: "isActive must be true or false." } },
      400
    );
  }

  try {
    const result = await setAutomationActive(accessToken, ruleId, payload.isActive);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "missing") {
      return safeJson(
        { error: { code: "not_found", message: "Automation not found." } },
        404
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

export async function DELETE(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const ruleId = await resolveRuleId(context);
  if (ruleId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid automation id." } },
      400
    );
  }

  try {
    const result = await deleteAutomation(accessToken, ruleId);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result === "missing") {
      return safeJson(
        { error: { code: "not_found", message: "Automation not found." } },
        404
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

const AUTOMATIONS_PAGE_FILE = `"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AutomationRule {
  id: number;
  keyword: string;
  actionType: "add_tag" | "assign";
  actionValue: string;
  isActive: boolean;
  timesTriggered: number;
  createdAt: string | null;
}

interface TeamMemberLite {
  email: string;
  name: string;
}

export default function AutomationsPage() {
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [expired, setExpired] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [actionType, setActionType] = useState<"add_tag" | "assign">("add_tag");
  const [actionValue, setActionValue] = useState("");
  const [teamMembers, setTeamMembers] = useState<TeamMemberLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/automations", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        automations?: AutomationRule[];
      } | null;
      if (mounted.current && payload && Array.isArray(payload.automations)) {
        setRules(payload.automations);
      }
    } catch {
      // Transient network issue — retry on next visit.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/team", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status !== 200) return;
        const payload = (await response.json().catch(() => null)) as {
          members?: { email?: string; name?: string; status?: string }[];
        } | null;
        if (mounted.current && payload && Array.isArray(payload.members)) {
          setTeamMembers(
            payload.members
              .filter(
                (member): member is { email: string; name?: string; status?: string } =>
                  member !== null &&
                  typeof member === "object" &&
                  typeof member.email === "string" &&
                  member.status === "active"
              )
              .map((member) => ({
                email: member.email,
                name: typeof member.name === "string" ? member.name : "",
              }))
          );
        }
      } catch {
        // Assign dropdown stays empty — typed emails still work via the API.
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function addRule() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ keyword, actionType, actionValue }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        automation?: AutomationRule;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok && payload.automation) {
        setRules((current) => [
          payload.automation as AutomationRule,
          ...(current ?? []),
        ]);
        setKeyword("");
        setActionValue("");
        setMessage({ kind: "ok", text: "Automation saved — it runs on every incoming message." });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save the automation.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: AutomationRule) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/automations/" + rule.id,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ isActive: !rule.isActive }),
        }
      );
      if (response.ok) {
        setRules((current) =>
          (current ?? []).map((item) =>
            item.id === rule.id ? { ...item, isActive: !item.isActive } : item
          )
        );
      }
    } catch {
      // Toggle is best-effort — reload to see the stored state.
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(rule: AutomationRule) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/automations/" + rule.id,
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setRules((current) =>
          (current ?? []).filter((item) => item.id !== rule.id)
        );
      }
    } catch {
      // Delete is best-effort — reload to see the stored state.
    } finally {
      setBusy(false);
    }
  }

  function describeAction(rule: AutomationRule): string {
    if (rule.actionType === "add_tag") return "Adds label #" + rule.actionValue;
    const member = teamMembers.find((item) => item.email === rule.actionValue);
    return "Assigns to " + (member ? member.name || member.email : rule.actionValue);
  }

  if (expired) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
        <p className="text-sm text-slate-300">Session expired.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-white">Automations</h1>
      <p className="mt-0.5 text-xs text-slate-500">
        Simple keyword rules that run instantly on every incoming message —
        WhatsApp and website. No AI, fully deterministic.
      </p>

      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <p className="text-xs font-medium text-slate-300">
          When a message contains…
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            maxLength={40}
            placeholder="keyword, e.g. wholesale"
            className="w-full sm:w-56 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <select
            value={actionType}
            onChange={(event) => {
              setActionType(event.target.value as "add_tag" | "assign");
              setActionValue("");
            }}
            className="w-full sm:w-44 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white outline-none"
          >
            <option value="add_tag">Add label…</option>
            <option value="assign">Assign to…</option>
          </select>
          {actionType === "add_tag" ? (
            <input
              value={actionValue}
              onChange={(event) => setActionValue(event.target.value)}
              maxLength={24}
              placeholder="label, e.g. pricing"
              className="w-full flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
            />
          ) : (
            <select
              value={actionValue}
              onChange={(event) => setActionValue(event.target.value)}
              className="w-full flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white outline-none"
            >
              <option value="">Choose team member…</option>
              {teamMembers.map((member) => (
                <option key={member.email} value={member.email}>
                  {member.name || member.email}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void addRule()}
            disabled={
              busy || !keyword.trim() || !actionValue.trim()
            }
            className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {busy ? "Working…" : "Add automation"}
          </button>
        </div>
        {message && (
          <p
            className={
              "mt-2 text-xs " +
              (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {message.text}
          </p>
        )}
      </div>

      {!rules ? (
        <div className="mt-4 animate-pulse space-y-3">
          {[0, 1].map((index) => (
            <div
              key={index}
              className="h-16 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">
            No automations yet — add your first rule above (for example
            &quot;wholesale&quot; adds the label #wholesale).
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-col gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm text-white">
                  <span className="rounded-md border border-cyan-400/20 bg-cyan-400/[0.06] px-1.5 py-0.5 text-xs font-semibold text-cyan-300">
                    {rule.keyword}
                  </span>
                  <span className="mx-2 text-slate-500">→</span>
                  <span className="text-xs text-slate-300">
                    {describeAction(rule)}
                  </span>
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Fired {rule.timesTriggered}
                  {rule.timesTriggered === 1 ? " time" : " times"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void toggleRule(rule)}
                  disabled={busy}
                  className={
                    "rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-colors duration-300 disabled:opacity-40 " +
                    (rule.isActive
                      ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                      : "border-white/[0.08] bg-white/[0.02] text-slate-400")
                  }
                >
                  {rule.isActive ? "Active" : "Paused"}
                </button>
                <button
                  type="button"
                  onClick={() => void removeRule(rule)}
                  disabled={busy}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors duration-300 hover:text-white disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
`;

const CP_AUTOMATIONS_APPEND = `


# ---------------------------------------------------------------------------
# Automations v0 — deterministic keyword rules on inbound messages
# ---------------------------------------------------------------------------

MAX_AUTOMATIONS = 20
MAX_KEYWORD_LENGTH = 40
AUTOMATION_ACTION_TYPES = ("add_tag", "assign")
AUTOMATIONS_TABLE = portal_db.AUTOMATIONS_TABLE


def _normalize_keyword(value) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\\s+", " ", value).strip().lower()[:MAX_KEYWORD_LENGTH]


def _automation_public(row: Any) -> dict:
    return {
        "id": int(row.get("id") or 0),
        "keyword": str(row.get("keyword") or ""),
        "action_type": row.get("action_type") or "add_tag",
        "action_value": str(row.get("action_value") or ""),
        "is_active": row.get("is_active") is True,
        "times_triggered": int(row.get("times_triggered") or 0),
        "created_at": _iso(row.get("created_at")),
    }


def apply_automation_rules(client_id, conversation_id, contact_id,
                           message_text, conn):
    """Deterministic keyword rules for one inbound message. Tags respect the
    6-label cap (ON CONFLICT DO NOTHING); assignment only fills unassigned
    chats. Runs inside the caller's transaction; callers wrap in try/except."""
    text = re.sub(r"\\s+", " ", str(message_text or "")).strip().lower()
    if not text:
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, keyword, action_type, action_value FROM "
            + portal_db._q(AUTOMATIONS_TABLE) +
            " WHERE client_id = %s AND is_active IS TRUE"
            " ORDER BY id LIMIT %s",
            (client_id, MAX_AUTOMATIONS),
        )
        rules = portal_db.rows(cur)
        for rule in rules:
            keyword = str(rule.get("keyword") or "")
            if not keyword or keyword not in text:
                continue
            action_type = rule.get("action_type")
            action_value = str(rule.get("action_value") or "")
            if action_type == "add_tag" and action_value:
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(portal_db.CONV_TAGS_TABLE) +
                    " WHERE client_id = %s AND conversation_id = %s",
                    (client_id, conversation_id),
                )
                counts = portal_db.rows(cur)
                total = int(counts[0].get("total") or 0) if counts else 0
                if total < MAX_TAGS_PER_CONVERSATION:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
                        " (client_id, conversation_id, tag, created_at)"
                        " VALUES (%s, %s, %s, NOW())"
                        " ON CONFLICT (client_id, conversation_id, tag)"
                        " DO NOTHING",
                        (client_id, conversation_id, action_value),
                    )
            elif action_type == "assign" and action_value:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET assigned_to = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s AND assigned_to IS NULL",
                    (action_value, conversation_id, client_id),
                )
            else:
                continue
            cur.execute(
                "UPDATE " + portal_db._q(AUTOMATIONS_TABLE) +
                " SET times_triggered = times_triggered + 1 WHERE id = %s",
                (rule.get("id"),),
            )
        if rules:
            portal_db.log_action(
                cur,
                client_id,
                "automation.checked",
                "system",
                None,
                conversation_id,
                ("Rules evaluated: %d" % len(rules))[:200],
            )


@bp.get("/automations")
def list_automations():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, keyword, action_type, action_value, is_active,"
                    " times_triggered, created_at FROM "
                    + portal_db._q(AUTOMATIONS_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                    (principal["client_id"], MAX_AUTOMATIONS),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "automations read")[0]), 503
    return jsonify({"automations": [_automation_public(row) for row in rows]}), 200


@bp.post("/automations")
def create_automation():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    keyword = _normalize_keyword(payload.get("keyword"))
    if len(keyword) < 2:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Keyword must be 2-40 characters."}}), 400
    action_type = payload.get("action_type", payload.get("actionType"))
    if action_type not in AUTOMATION_ACTION_TYPES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Action must be add_tag or assign."}}), 400
    if action_type == "add_tag":
        action_value = _clean_tag(payload.get("action_value",
                                              payload.get("actionValue")))
        if not action_value:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Label value is required."}}), 400
    else:
        action_value = str(payload.get("action_value",
                                       payload.get("actionValue")) or "").strip().lower()[:120]
        if not action_value:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Assignee email is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                if action_type == "assign":
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q(portal_db.TEAM_TABLE) +
                        " WHERE client_id = %s AND email = %s"
                        " AND status = 'active' LIMIT 1",
                        (principal["client_id"], action_value),
                    )
                    if not portal_db.rows(cur):
                        return jsonify({"error": {"code": "assignee_not_found",
                                                  "message": "Assignee must be an active team member."}}), 400
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(AUTOMATIONS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                counts = portal_db.rows(cur)
                if counts and int(counts[0].get("total") or 0) >= MAX_AUTOMATIONS:
                    return jsonify({"error": {"code": "limit_reached",
                                              "message": "Up to 20 automations."}}), 409
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(AUTOMATIONS_TABLE) +
                    " WHERE client_id = %s AND keyword = %s"
                    " AND action_type = %s AND LOWER(action_value) = LOWER(%s)"
                    " LIMIT 1",
                    (principal["client_id"], keyword, action_type, action_value),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "duplicate",
                                              "message": "A rule with this keyword and action already exists."}}), 409
                cur.execute(
                    "INSERT INTO " + portal_db._q(AUTOMATIONS_TABLE) +
                    " (client_id, keyword, action_type, action_value,"
                    " is_active, times_triggered, created_at, updated_at)"
                    " VALUES (%s, %s, %s, %s, TRUE, 0, NOW(), NOW())"
                    " RETURNING id, keyword, action_type, action_value,"
                    " is_active, times_triggered, created_at",
                    (principal["client_id"], keyword, action_type, action_value),
                )
                inserted = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "automation.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Automation added: " + keyword
                     + " -> " + action_type + " " + action_value)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "automation create")[0]), 503
    if not inserted:
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "Try again shortly."}}), 503
    return jsonify({"ok": True, "automation": _automation_public(inserted[0])}), 200


@bp.patch("/automations/<int:rule_id>")
def update_automation(rule_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    is_active = payload.get("is_active", payload.get("isActive"))
    if not isinstance(is_active, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "is_active must be true or false."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(AUTOMATIONS_TABLE) +
                    " SET is_active = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING keyword",
                    (is_active, rule_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Automation not found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "automation.updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Automation " + ("enabled: " if is_active else "disabled: ")
                    + str(updated[0].get("keyword") or ""),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "automation update")[0]), 503
    return jsonify({"ok": True}), 200


@bp.delete("/automations/<int:rule_id>")
def delete_automation(rule_id: int):
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
                    "DELETE FROM " + portal_db._q(AUTOMATIONS_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING keyword",
                    (rule_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
                if not deleted:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Automation not found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "automation.deleted",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Automation deleted: " + str(deleted[0].get("keyword") or ""),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "automation delete")[0]), 503
    return jsonify({"ok": True}), 200
`;

const PORTAL_TS_AUTOMATIONS_SECTION = `// ---------------------------------------------------------------------------
// Automations (deterministic keyword rules)
// ---------------------------------------------------------------------------

export interface AutomationRule {
  id: number;
  keyword: string;
  actionType: "add_tag" | "assign";
  actionValue: string;
  isActive: boolean;
  timesTriggered: number;
  createdAt: string | null;
}

function normalizeAutomation(value: unknown): AutomationRule | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    keyword: typeof p.keyword === "string" ? p.keyword : "",
    actionType: p.action_type === "assign" ? "assign" : "add_tag",
    actionValue: typeof p.action_value === "string" ? p.action_value : "",
    isActive: p.is_active === true,
    timesTriggered: typeof p.times_triggered === "number" ? p.times_triggered : 0,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listAutomations(
  accessToken: string
): Promise<AutomationRule[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).automations;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeAutomation(row))
    .filter((row): row is AutomationRule => row !== null);
}

export type AutomationWriteResult =
  | { kind: "ok"; automation: AutomationRule }
  | { kind: "invalid" }
  | { kind: "assignee_not_found" }
  | { kind: "duplicate" }
  | { kind: "limit_reached" };

export async function createAutomation(
  accessToken: string,
  keyword: string,
  actionType: "add_tag" | "assign",
  actionValue: string
): Promise<AutomationWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword,
        action_type: actionType,
        action_value: actionValue,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
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
    return { kind: "invalid" };
  }
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const error = payload as {
      error?: { code?: string };
    } | null;
    if (error?.error?.code === "limit_reached") return { kind: "limit_reached" };
    return { kind: "duplicate" };
  }
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const automation = normalizeAutomation(
    (payload as Record<string, unknown>).automation
  );
  if (automation === null) return null;
  return { kind: "ok", automation };
}

export async function setAutomationActive(
  accessToken: string,
  ruleId: number,
  isActive: boolean
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/automations/" + ruleId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

export async function deleteAutomation(
  accessToken: string,
  ruleId: number
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/automations/" + ruleId,
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

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "automations table constant",
        from: `SAVED_REPLIES_TABLE = os.environ.get("OF_SAVEDREPLIES_TABLE", "portal_saved_replies")`,
        to: `SAVED_REPLIES_TABLE = os.environ.get("OF_SAVEDREPLIES_TABLE", "portal_saved_replies")
AUTOMATIONS_TABLE = os.environ.get("OF_AUTOMATIONS_TABLE", "portal_automations")`,
      },
      {
        name: "automations DDL",
        from: `ALTER TABLE portal_widget_settings
  ADD COLUMN IF NOT EXISTS launcher_label TEXT NOT NULL DEFAULT '';
"""`,
        to: `ALTER TABLE portal_widget_settings
  ADD COLUMN IF NOT EXISTS launcher_label TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS portal_automations (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  keyword TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_value TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  times_triggered INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_automation UNIQUE (client_id, keyword, action_type, action_value)
);
CREATE INDEX IF NOT EXISTS idx_portal_automations
  ON portal_automations (client_id, is_active);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "automations endpoints + engine appended",
        from: `    customers = []
    for row in found:
        max_score = int(row.get("max_lead_score") or 0)
        if row.get("has_hot"):
            lead_temp = "hot"
        elif max_score >= WARM_LEAD_SCORE:
            lead_temp = "warm"
        else:
            lead_temp = "cold"
        customers.append({
            "contact_id": row.get("contact_id"),
            "name": str(row.get("contact_name") or ""),
            "channels": [
                part for part in str(row.get("channels") or "").split(",") if part
            ],
            "conversation_count": int(row.get("conversation_count") or 0),
            "open_count": int(row.get("open_count") or 0),
            "last_message_at": _iso(row.get("last_message_at")),
            "last_message_preview": row.get("last_message_preview"),
            "lead_temp": lead_temp,
            "tags": tags_map.get(row.get("contact_id"), []),
        })
    return jsonify({"customers": customers}), 200`,
        to: `    customers = []
    for row in found:
        max_score = int(row.get("max_lead_score") or 0)
        if row.get("has_hot"):
            lead_temp = "hot"
        elif max_score >= WARM_LEAD_SCORE:
            lead_temp = "warm"
        else:
            lead_temp = "cold"
        customers.append({
            "contact_id": row.get("contact_id"),
            "name": str(row.get("contact_name") or ""),
            "channels": [
                part for part in str(row.get("channels") or "").split(",") if part
            ],
            "conversation_count": int(row.get("conversation_count") or 0),
            "open_count": int(row.get("open_count") or 0),
            "last_message_at": _iso(row.get("last_message_at")),
            "last_message_preview": row.get("last_message_preview"),
            "lead_temp": lead_temp,
            "tags": tags_map.get(row.get("contact_id"), []),
        })
    return jsonify({"customers": customers}), 200
` + CP_AUTOMATIONS_APPEND,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      {
        name: "import portal_conversations",
        from: `import portal_followups
import portal_kb
import portal_revenue
import portal_growth`,
        to: `import portal_followups
import portal_kb
import portal_revenue
import portal_growth
import portal_conversations`,
      },
      {
        name: "ingest hook fires automations",
        from: `                        portal_growth.handle_inbound(
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
        to: `                        portal_growth.handle_inbound(
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
                    try:
                        portal_conversations.apply_automation_rules(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["body"],
                            conn,
                        )
                    except Exception:
                        pass
                    inserted += 1`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_widget.py",
    swaps: [
      {
        name: "import portal_conversations",
        from: `import portal_db
import portal_kb
import intent_classifier`,
        to: `import portal_db
import portal_kb
import portal_conversations
import intent_classifier`,
      },
      {
        name: "widget hook fires automations",
        from: `                auto = _auto_answer(cur, client_id, conversation_id, text, intent)
                if auto is not None:
                    reply_body, reply_created = auto`,
        to: `                auto = _auto_answer(cur, client_id, conversation_id, text, intent)
                if auto is not None:
                    reply_body, reply_created = auto
                try:
                    portal_conversations.apply_automation_rules(
                        client_id,
                        conversation_id,
                        "web_" + visitor,
                        text,
                        conn,
                    )
                except Exception:
                    pass`,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "automations client functions",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_AUTOMATIONS_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "sidebar automations entry",
        from: `  {
    label: "Customers",
    href: "/dashboard/customers",
    icon: "☻",
    enabled: true,
  },`,
        to: `  {
    label: "Customers",
    href: "/dashboard/customers",
    icon: "☻",
    enabled: true,
  },
  {
    label: "Automations",
    href: "/dashboard/automations",
    icon: "⚡",
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

  const backup = target.file + ".pre_auto.bak";
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
  [BFF_AUTOMATIONS_PATH, BFF_AUTOMATIONS_FILE],
  [BFF_AUTOMATION_ID_PATH, BFF_AUTOMATION_ID_FILE],
  [AUTOMATIONS_PAGE_PATH, AUTOMATIONS_PAGE_FILE],
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