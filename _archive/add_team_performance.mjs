// add_team_performance.mjs — Phase 18: Agent Performance (Team Insights) v0.
//
// Zero AI, zero schema changes, no bridge changes -> NO bot restart. The Team
// page so far only manages members; now it answers "who is doing what" with a
// deterministic, SQL-only performance section for the last N days (default 7):
//
//   - Board strip: open conversations, unassigned open, team replies sent,
//     CSAT average (answered in window) + answered count.
//   - Per member: replies sent (queued send_message commands attributed via
//     platform_users.email), chats touched (distinct conversations from those
//     commands), internal notes written, conversations currently assigned
//     (open) to them. Sorted by replies desc, then name.
//
// CP: GET /portal/team/performance appended to portal_team.py (human session
// read, same auth as GET /portal/team; no DDL — every column already exists).
// BFF passthrough: app/api/omniflow/portal/team/performance/route.ts.
// UI: Performance section at the top of /dashboard/team (mobile-first).
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_team_performance.mjs
//
// Requires Phase 17 (add_automations.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_perf.bak
// Expected first run: 8 applied, 0 warnings (7 swaps + 1 new file).
// Expected rerun:     0 applied, 8 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_PERF_PATH = "Omniflow/app/api/omniflow/portal/team/performance/route.ts";

const CP_TEAM_PATH = "OmniFlow-Control-Plane/portal_team.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const TEAM_PAGE_PATH = "Omniflow/app/dashboard/(portal)/team/page.tsx";

// --------------------------------------------------------------------------
// Control Plane: portal_team.py
// --------------------------------------------------------------------------

const CP_OS_IMPORT_FROM = `import logging
import re
from typing import Any, Dict, List, Optional`;

const CP_OS_IMPORT_TO = `import logging
import os
import re
from typing import Any, Dict, List, Optional`;

const CP_TAIL_FROM = `    return jsonify({"ok": True, "note": _note_public(note_row or {})}), 200`;

const CP_PERF_ROUTE = `    return jsonify({"ok": True, "note": _note_public(note_row or {})}), 200


# ---------------------------------------------------------------------------
# Agent performance (last N days, deterministic SQL — zero AI)
# ---------------------------------------------------------------------------

try:
    PERF_WINDOW_DAYS = max(
        1, min(30, int(os.environ.get("OF_PERF_WINDOW_DAYS", "7") or 7))
    )
except ValueError:
    PERF_WINDOW_DAYS = 7


@bp.get("/portal/team/performance")
def team_performance():
    """Per-member activity for the last PERF_WINDOW_DAYS + live board counters.

    Deterministic only: replies are queued send_message commands attributed
    through platform_users.email, notes by author_email, plus the current
    open-assignment snapshot. No bridge involvement, no AI cost.
    """
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, email, name, role, status FROM "
                    + portal_db._q(TEAM_TABLE) +
                    " WHERE client_id = %s ORDER BY id ASC",
                    (client_id,),
                )
                members = portal_db.rows(cur)
                emails = []
                for member in members:
                    email = str(member.get("email") or "").strip().lower()
                    if email and email not in emails:
                        emails.append(email)
                reply_by_email: Dict[str, int] = {}
                touched_by_email: Dict[str, int] = {}
                if emails:
                    cur.execute(
                        "SELECT LOWER(pu.email) AS email, COUNT(*) AS replies_sent,"
                        " COUNT(DISTINCT cmd.payload->>'conversation_id')"
                        " AS conversations_touched"
                        " FROM " + portal_db._q(portal_db.CMD_TABLE) + " cmd"
                        " JOIN " + portal_db._q(portal_db.USERS_TABLE) + " pu"
                        " ON pu.id = cmd.requested_by"
                        " WHERE cmd.client_id = %s AND cmd.action = 'send_message'"
                        " AND cmd.created_at >= NOW()"
                        " - CAST(%s AS INT) * INTERVAL '1 day'"
                        " AND LOWER(pu.email) = ANY(%s)"
                        " GROUP BY LOWER(pu.email)",
                        (client_id, PERF_WINDOW_DAYS, emails),
                    )
                    for row in portal_db.rows(cur):
                        email = str(row.get("email") or "").strip().lower()
                        reply_by_email[email] = int(row.get("replies_sent") or 0)
                        touched_by_email[email] = int(
                            row.get("conversations_touched") or 0
                        )
                notes_by_email: Dict[str, int] = {}
                cur.execute(
                    "SELECT LOWER(author_email) AS email, COUNT(*) AS notes_added"
                    " FROM " + portal_db._q(NOTES_TABLE) +
                    " WHERE client_id = %s"
                    " AND created_at >= NOW() - CAST(%s AS INT) * INTERVAL '1 day'"
                    " GROUP BY LOWER(author_email)",
                    (client_id, PERF_WINDOW_DAYS),
                )
                for row in portal_db.rows(cur):
                    email = str(row.get("email") or "").strip().lower()
                    notes_by_email[email] = int(row.get("notes_added") or 0)
                assigned_by_email: Dict[str, int] = {}
                cur.execute(
                    "SELECT LOWER(assigned_to) AS email, COUNT(*) AS open_count"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND status = 'open'"
                    " AND assigned_to IS NOT NULL"
                    " GROUP BY LOWER(assigned_to)",
                    (client_id,),
                )
                for row in portal_db.rows(cur):
                    email = str(row.get("email") or "").strip().lower()
                    assigned_by_email[email] = int(row.get("open_count") or 0)
                cur.execute(
                    "SELECT COUNT(*) FILTER (WHERE status = 'open') AS open_total,"
                    " COUNT(*) FILTER (WHERE status = 'open'"
                    " AND assigned_to IS NULL) AS unassigned_open"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s",
                    (client_id,),
                )
                board_rows = portal_db.rows(cur)
                board_row = board_rows[0] if board_rows else {}
                cur.execute(
                    "SELECT COUNT(*) AS answered, AVG(score) AS avg_score"
                    " FROM " + portal_db._q(portal_db.CSAT_TABLE) +
                    " WHERE client_id = %s AND score IS NOT NULL"
                    " AND answered_at >= NOW()"
                    " - CAST(%s AS INT) * INTERVAL '1 day'",
                    (client_id, PERF_WINDOW_DAYS),
                )
                csat_rows = portal_db.rows(cur)
                csat_row = csat_rows[0] if csat_rows else {}
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "team performance")[0]), 503
    performance = []
    total_replies = 0
    for member in members:
        email = str(member.get("email") or "").strip().lower()
        replies_sent = reply_by_email.get(email, 0)
        total_replies += replies_sent
        role = member.get("role")
        performance.append({
            "id": member.get("id"),
            "email": member.get("email"),
            "name": member.get("name"),
            "role": role if role in ("owner", "admin", "agent") else "agent",
            "status": "disabled" if member.get("status") == "disabled" else "active",
            "replies_sent": replies_sent,
            "conversations_touched": touched_by_email.get(email, 0),
            "notes_added": notes_by_email.get(email, 0),
            "assigned_open": assigned_by_email.get(email, 0),
        })
    performance.sort(
        key=lambda item: (
            -item["replies_sent"],
            str(item.get("name") or item.get("email") or "").lower(),
        )
    )
    avg_score = csat_row.get("avg_score")
    try:
        csat_avg = round(float(avg_score), 1) if avg_score is not None else None
    except (TypeError, ValueError):
        csat_avg = None
    return jsonify({
        "ok": True,
        "window_days": PERF_WINDOW_DAYS,
        "members": performance,
        "board": {
            "open_conversations": int(board_row.get("open_total") or 0),
            "unassigned_open": int(board_row.get("unassigned_open") or 0),
            "replies_sent": total_replies,
            "csat_avg": csat_avg,
            "csat_answered": int(csat_row.get("answered") or 0),
        },
    }), 200`;

// --------------------------------------------------------------------------
// Website: lib/omniflow/portal.ts (inserted before the Growth banner)
// --------------------------------------------------------------------------

const LIB_GROWTH_BANNER = `// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------`;

const LIB_PERF_BLOCK = `// ---------------------------------------------------------------------------
// Team: agent performance (last N days, deterministic)
// ---------------------------------------------------------------------------

export interface TeamPerformanceMember {
  id: number;
  email: string;
  name: string;
  role: TeamRole;
  status: string;
  repliesSent: number;
  conversationsTouched: number;
  notesAdded: number;
  assignedOpen: number;
}

export interface TeamPerformanceBoard {
  openConversations: number;
  unassignedOpen: number;
  repliesSent: number;
  csatAvg: number | null;
  csatAnswered: number;
}

export interface TeamPerformanceData {
  windowDays: number;
  members: TeamPerformanceMember[];
  board: TeamPerformanceBoard;
}

function normalizePerformanceMember(value: unknown): TeamPerformanceMember | null {
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
    repliesSent: typeof p.replies_sent === "number" ? p.replies_sent : 0,
    conversationsTouched:
      typeof p.conversations_touched === "number" ? p.conversations_touched : 0,
    notesAdded: typeof p.notes_added === "number" ? p.notes_added : 0,
    assignedOpen: typeof p.assigned_open === "number" ? p.assigned_open : 0,
  };
}

export async function getTeamPerformance(
  accessToken: string
): Promise<TeamPerformanceData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/team/performance");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawMembers = p.members;
  const members: TeamPerformanceMember[] = [];
  if (Array.isArray(rawMembers)) {
    for (const raw of rawMembers) {
      const row = normalizePerformanceMember(raw);
      if (row) members.push(row);
    }
  }
  const boardRaw =
    p.board !== null && typeof p.board === "object"
      ? (p.board as Record<string, unknown>)
      : {};
  return {
    windowDays: typeof p.window_days === "number" ? p.window_days : 7,
    members,
    board: {
      openConversations:
        typeof boardRaw.open_conversations === "number"
          ? boardRaw.open_conversations
          : 0,
      unassignedOpen:
        typeof boardRaw.unassigned_open === "number" ? boardRaw.unassigned_open : 0,
      repliesSent: typeof boardRaw.replies_sent === "number" ? boardRaw.replies_sent : 0,
      csatAvg: typeof boardRaw.csat_avg === "number" ? boardRaw.csat_avg : null,
      csatAnswered:
        typeof boardRaw.csat_answered === "number" ? boardRaw.csat_answered : 0,
    },
  };
}

` + LIB_GROWTH_BANNER;

// --------------------------------------------------------------------------
// Website: BFF passthrough (new file)
// --------------------------------------------------------------------------

const BFF_PERF_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getTeamPerformance,
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
    const data = await getTeamPerformance(accessToken);
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

// --------------------------------------------------------------------------
// Website: Team page (4 swaps)
// --------------------------------------------------------------------------

const PAGE_INTERFACE_FROM = `interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: "owner" | "admin" | "agent";
  status: string;
}`;

const PAGE_INTERFACE_TO = `interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: "owner" | "admin" | "agent";
  status: string;
}

interface PerfMember {
  id: number;
  name: string;
  email: string;
  role: "owner" | "admin" | "agent";
  repliesSent: number;
  conversationsTouched: number;
  notesAdded: number;
  assignedOpen: number;
}

interface PerfData {
  windowDays: number;
  members: PerfMember[];
  board: {
    openConversations: number;
    unassignedOpen: number;
    repliesSent: number;
    csatAvg: number | null;
    csatAnswered: number;
  };
}

function perfStatClass(value: number): string {
  return value > 0 ? "text-white" : "text-slate-600";
}`;

const PAGE_STATE_FROM = `  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );`;

const PAGE_STATE_TO = `  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );
  const [perf, setPerf] = useState<PerfData | null>(null);`;

const PAGE_EFFECT_FROM = `  useEffect(() => {
    void load();
  }, [load]);`;

const PAGE_EFFECT_TO = `  const loadPerf = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/team/performance", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as PerfData | null;
      if (payload && Array.isArray(payload.members)) setPerf(payload);
    } catch {
      // Performance is additive — never block the team page on it.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPerf();
  }, [load, loadPerf]);`;

const PAGE_HEADER_FROM = `          are never sent to customers.
        </p>
      </div>`;

const PAGE_HEADER_TO = `          are never sent to customers.
        </p>
      </div>

      {perf && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Performance
            </h2>
            <span className="text-[10px] text-slate-600">
              Last {perf.windowDays} {perf.windowDays === 1 ? "day" : "days"}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-600">
                Open chats
              </p>
              <p className={"mt-0.5 text-lg font-semibold " + perfStatClass(perf.board.openConversations)}>
                {perf.board.openConversations}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-600">
                Unassigned
              </p>
              <p className={"mt-0.5 text-lg font-semibold " + perfStatClass(perf.board.unassignedOpen)}>
                {perf.board.unassignedOpen}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-600">
                Team replies
              </p>
              <p className={"mt-0.5 text-lg font-semibold " + perfStatClass(perf.board.repliesSent)}>
                {perf.board.repliesSent}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-600">
                CSAT avg
              </p>
              <p className="mt-0.5 text-lg font-semibold text-white">
                {perf.board.csatAvg !== null ? perf.board.csatAvg.toFixed(1) : "—"}
                <span className="ml-1 text-[10px] font-normal text-slate-600">
                  {perf.board.csatAnswered > 0
                    ? "(" + perf.board.csatAnswered + ")"
                    : ""}
                </span>
              </p>
            </div>
          </div>
          {perf.members.length > 0 && (
            <ul className="mt-3 space-y-2">
              {perf.members.map((member) => (
                <li
                  key={"perf-" + String(member.id)}
                  className="rounded-xl border border-white/[0.05] bg-white/[0.01] p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-xs font-semibold text-slate-300">
                        {(member.name || member.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">
                          {member.name || member.email}
                          {member.role === "owner" && (
                            <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wider text-cyan-300">
                              owner
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[10px] text-slate-600">
                          {member.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 sm:justify-end">
                      <span>
                        <span className={perfStatClass(member.repliesSent) + " font-semibold"}>
                          {member.repliesSent}
                        </span>{" "}
                        replies
                      </span>
                      <span>
                        <span className={perfStatClass(member.conversationsTouched) + " font-semibold"}>
                          {member.conversationsTouched}
                        </span>{" "}
                        chats touched
                      </span>
                      <span>
                        <span className={perfStatClass(member.notesAdded) + " font-semibold"}>
                          {member.notesAdded}
                        </span>{" "}
                        notes
                      </span>
                      <span>
                        <span className={perfStatClass(member.assignedOpen) + " font-semibold"}>
                          {member.assignedOpen}
                        </span>{" "}
                        assigned
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}`;

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------

const TARGETS = [
  {
    file: CP_TEAM_PATH,
    swaps: [
      { name: "cp-os-import", from: CP_OS_IMPORT_FROM, to: CP_OS_IMPORT_TO },
      { name: "cp-performance-route", from: CP_TAIL_FROM, to: CP_PERF_ROUTE },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-performance-block", from: LIB_GROWTH_BANNER, to: LIB_PERF_BLOCK },
    ],
  },
  {
    file: TEAM_PAGE_PATH,
    swaps: [
      { name: "page-interfaces", from: PAGE_INTERFACE_FROM, to: PAGE_INTERFACE_TO },
      { name: "page-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-load-perf", from: PAGE_EFFECT_FROM, to: PAGE_EFFECT_TO },
      { name: "page-section", from: PAGE_HEADER_FROM, to: PAGE_HEADER_TO },
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

  const backup = target.file + ".pre_perf.bak";
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
const NEW_FILES = [[BFF_PERF_PATH, BFF_PERF_FILE]];
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