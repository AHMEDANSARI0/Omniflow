// add_read_all.mjs - Phase 44: mark every open conversation as read.
//
// New POST /portal/conversations/read-all sets last_read_at = NOW() on all
// open conversations of the client (one UPDATE, audit-logged). The inbox gets
// a Mark-all-read button next to Export CSV, enabled only when the unread
// count is above zero. Requires Phase 42 applied first. Adds one BFF route
// file, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const BFF_READALL_PATH = "Omniflow/app/api/omniflow/portal/conversations/read-all/route.ts";

const NEW_FILES = [
  {
    path: BFF_READALL_PATH,
    content: `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  markAllConversationsRead,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function POST() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const result = await markAllConversationsRead(accessToken);
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`,
  },
];

// portal_conversations.py

const CP_ENDPOINT_FROM = `@bp.get("/conversations/export")`;

const CP_ENDPOINT_TO = `@bp.post("/conversations/read-all")
def mark_all_conversations_read():
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET last_read_at = NOW()"
                    " WHERE client_id = %s AND status = 'open' RETURNING id",
                    (principal["client_id"],),
                )
                updated = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "conversation.read_all",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Marked " + str(len(updated)) + " conversations read.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation read-all")[0]), 503
    return jsonify({"ok": True, "updated": len(updated)}), 200


@bp.get("/conversations/export")`;

// lib/omniflow/portal.ts

const LIB_FN_FROM = `export interface IntentSummaryEntry {`;

const LIB_FN_TO = `export async function markAllConversationsRead(
  accessToken: string
): Promise<{ updated: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/conversations/read-all", {
      method: "POST",
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

export interface IntentSummaryEntry {`;

// inbox page

const PAGE_HELPER_FROM = `  async function exportCsv(selectedIds?: number[]) {`;

const PAGE_HELPER_TO = `  async function markAllRead() {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations/read-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (response.ok) void refresh();
    } catch {
      // Transient network issue, the user can retry.
    } finally {
      setBulkBusy(false);
    }
  }

  async function exportCsv(selectedIds?: number[]) {`;

const PAGE_BUTTON_FROM = `        <button
          type="button"
          onClick={() => void exportCsv()}`;

const PAGE_BUTTON_TO = `        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={bulkBusy || !chipCounts.unread}
          title="Mark every open conversation as read"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
        >
          Mark all read
        </button>
        <button
          type="button"
          onClick={() => void exportCsv()}`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-read-all", from: CP_ENDPOINT_FROM, to: CP_ENDPOINT_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-read-all", from: LIB_FN_FROM, to: LIB_FN_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-helper", from: PAGE_HELPER_FROM, to: PAGE_HELPER_TO },
      { name: "inbox-button", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
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

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path)) {
    alreadyTotal++;
  } else {
    writeFileEnsuringDir(file.path, file.content);
    appliedTotal++;
    console.log("+ NEW " + file.path);
  }
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

  const backup = target.file + ".pre_readall.bak";
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