// add_bulk_actions.mjs - Phase 33: bulk close, reopen and assign in the inbox.
//
// POST /portal/conversations/bulk accepts action=close|reopen|assign|unassign
// with up to 50 conversation ids (assign also takes assignee_email and checks
// the teammate is active). The inbox gets per-row checkboxes plus a bulk bar
// with Close, Reopen, Assign and Unassign. Requires Phase 32 applied first.
// No new files, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

// portal_conversations.py

const CP_CONST_FROM = `MESSAGE_PAGE_SIZE = 200`;

const CP_CONST_TO = `MESSAGE_PAGE_SIZE = 200
BULK_MAX_IDS = 50`;

const CP_ENDPOINT_FROM = `@bp.post("/conversations/<int:conversation_id>/messages")`;

const CP_ENDPOINT_TO = `@bp.post("/conversations/bulk")
def bulk_update_conversations():
    principal, error = _principal_or_error()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action") or "").strip().lower()
    if action not in ("close", "reopen", "assign", "unassign"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "action must be close, reopen, assign, or unassign."}}), 400
    raw_ids = payload.get("ids")
    if not isinstance(raw_ids, list):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "ids must be a list."}}), 400
    ids = []
    for value in raw_ids[:BULK_MAX_IDS]:
        if isinstance(value, int) and not isinstance(value, bool) and value > 0 and value not in ids:
            ids.append(value)
    if not ids:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "At least one conversation id is required."}}), 400

    assignee = ""
    if action == "assign":
        assignee = str(payload.get("assignee_email") or "").strip().lower()[:120]
        if not assignee:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "assignee_email is required for assign."}}), 400

    status_value = {"close": "closed", "reopen": "open"}.get(action)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                if action == "assign":
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q(portal_db.TEAM_TABLE) +
                        " WHERE client_id = %s AND email = %s"
                        " AND (status = 'active' OR status IS NULL) LIMIT 1",
                        (principal["client_id"], assignee),
                    )
                    if not portal_db.rows(cur):
                        return jsonify({"error": {"code": "assignee_not_found",
                                                  "message": "That teammate is not an active member."}}), 404
                if status_value:
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                        " SET status = %s, updated_at = NOW()"
                        " WHERE client_id = %s AND id = ANY(%s) RETURNING id",
                        (status_value, principal["client_id"], ids),
                    )
                elif action == "assign":
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                        " SET assigned_to = %s, updated_at = NOW()"
                        " WHERE client_id = %s AND id = ANY(%s) RETURNING id",
                        (assignee, principal["client_id"], ids),
                    )
                else:
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                        " SET assigned_to = NULL, updated_at = NOW()"
                        " WHERE client_id = %s AND id = ANY(%s) RETURNING id",
                        (principal["client_id"], ids),
                    )
                updated = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "conversation.bulk_" + action,
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Bulk " + action + " on " + str(len(updated)) + " conversations.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation bulk update")[0]), 503
    return jsonify({"ok": True, "updated": len(updated)}), 200


@bp.post("/conversations/<int:conversation_id>/messages")`;

// lib/omniflow/portal.ts

const LIB_BULK_FROM = `export type ConversationDetailResult =`;

const LIB_BULK_TO = `export async function bulkConversations(
  accessToken: string,
  action: string,
  ids: number[],
  assigneeEmail?: string
): Promise<{ updated: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/conversations/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        action === "assign"
          ? { action, ids, assignee_email: assigneeEmail || "" }
          : { action, ids }
      ),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const updated = (payload as Record<string, unknown>).updated;
  return { updated: typeof updated === "number" ? updated : 0 };
}

export type ConversationDetailResult =`;

// BFF conversations route

const BFF_IMPORT_FROM = `import {
  listConversations,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";`;

const BFF_IMPORT_TO = `import {
  bulkConversations,
  listConversations,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";`;

const BFF_POST_FROM = `export function OPTIONS() {`;

const BFF_POST_TO = `export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    action?: unknown;
    ids?: unknown;
    assignee_email?: unknown;
  } | null;
  const action =
    typeof payload?.action === "string" ? payload.action.trim().toLowerCase() : "";
  if (
    action !== "close" &&
    action !== "reopen" &&
    action !== "assign" &&
    action !== "unassign"
  ) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid action." } },
      400
    );
  }
  const rawIds = Array.isArray(payload?.ids) ? payload.ids : [];
  const ids: number[] = [];
  for (const value of rawIds.slice(0, 50)) {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      !ids.includes(value)
    ) {
      ids.push(value);
    }
  }
  if (ids.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Select at least one conversation." } },
      400
    );
  }
  const assigneeEmail =
    action === "assign" && typeof payload?.assignee_email === "string"
      ? payload.assignee_email.trim().toLowerCase().slice(0, 120)
      : "";
  if (action === "assign" && !assigneeEmail) {
    return safeJson(
      { error: { code: "bad_request", message: "Assignee is required." } },
      400
    );
  }

  try {
    const result = await bulkConversations(accessToken, action, ids, assigneeEmail);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
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

export function OPTIONS() {`;

// inbox page

const PAGE_STATE_FROM = `  const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
  });`;

const PAGE_STATE_TO = `  const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
  });
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [assignTarget, setAssignTarget] = useState("");`;

const PAGE_HELPERS_FROM = `  async function exportCsv() {`;

const PAGE_HELPERS_TO = `  function toggleSelected(conversationId: number) {
    setSelectedIds((current) =>
      current.includes(conversationId)
        ? current.filter((value) => value !== conversationId)
        : [...current, conversationId]
    );
  }

  async function bulkAction(action: string, assigneeEmail?: string) {
    if (bulkBusy || selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          action === "assign"
            ? { action, ids: selectedIds, assignee_email: assigneeEmail || "" }
            : { action, ids: selectedIds }
        ),
      });
      if (response.ok) {
        setSelectedIds([]);
        void refresh();
      }
    } catch {
      // Transient network issue, the user can retry.
    } finally {
      setBulkBusy(false);
    }
  }

  async function exportCsv() {`;

const PAGE_BULK_BAR_FROM = `      {!items ? (`;

const PAGE_BULK_BAR_TO = `      {selectedIds.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] px-3 py-2">
          <span className="text-xs font-medium text-cyan-200">
            {selectedIds.length} selected
          </span>
          <button
            type="button"
            onClick={() => void bulkAction("close")}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void bulkAction("reopen")}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Reopen
          </button>
          <select
            value={assignTarget}
            disabled={bulkBusy || teamMembers.length === 0}
            onChange={(event) => {
              const email = event.target.value;
              setAssignTarget("");
              if (email) void bulkAction("assign", email);
            }}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 disabled:opacity-40"
          >
            <option value="">Assign to...</option>
            {teamMembers.map((member) => (
              <option key={member.email} value={member.email}>
                {member.name || member.email}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void bulkAction("unassign")}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Unassign
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            className="ml-auto rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:text-white"
          >
            Clear
          </button>
        </div>
      )}

      {!items ? (`;

const PAGE_LI_FROM = `            <li key={item.id}>
              <Link
                href={\`/dashboard/conversations/\${item.id}\`}
                className="block rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]"
              >`;

const PAGE_LI_TO = `            <li key={item.id} className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label={
                  "Select conversation " + (item.contactName || item.contactId || "")
                }
                checked={selectedIds.includes(item.id)}
                onChange={() => toggleSelected(item.id)}
                className="mt-4 h-5 w-5 shrink-0 accent-cyan-400"
              />
              <Link
                href={\`/dashboard/conversations/\${item.id}\`}
                className="block min-w-0 flex-1 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]"
              >`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-const", from: CP_CONST_FROM, to: CP_CONST_TO },
      { name: "cp-bulk-endpoint", from: CP_ENDPOINT_FROM, to: CP_ENDPOINT_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-bulk", from: LIB_BULK_FROM, to: LIB_BULK_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-import", from: BFF_IMPORT_FROM, to: BFF_IMPORT_TO },
      { name: "bff-post", from: BFF_POST_FROM, to: BFF_POST_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-helpers", from: PAGE_HELPERS_FROM, to: PAGE_HELPERS_TO },
      { name: "inbox-bulk-bar", from: PAGE_BULK_BAR_FROM, to: PAGE_BULK_BAR_TO },
      { name: "inbox-row-checkbox", from: PAGE_LI_FROM, to: PAGE_LI_TO },
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

  const backup = target.file + ".pre_bulk.bak";
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