// add_autoassign_chats.mjs — Phase 23: Auto-Assign New Chats (least-loaded).
//
// Zero AI, no bridge process changes -> NO bot restart. WATI-style round
// robin, done deterministically and fairer: when a brand-new chat arrives
// (same is_new signal as the welcome automation), it is assigned
// automatically to the ACTIVE team member with the FEWEST open chats right
// now (tie-break: lowest team id). No cursor storage, no skew.
//
//   - CP: portal_automation_settings gains assign_enabled (lazy ALTER).
//     GET/PUT /portal/automations/autoassign (human session writes, audited).
//   - Engine: auto_assign_new_chat(client_id, conversation_id, conn) — one
//     settings read, one least-loaded member pick, one UPDATE, audit row.
//     Hooked in the WhatsApp ingest path next to the welcome hook (is_new +
//     inbound gated, try/except-wrapped).
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_autoassign_chats.mjs
//
// Requires Phase 22 (add_needs_reply.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_aassign.bak
// Expected first run: 10 applied, 0 warnings (9 swaps + 1 new file).
// Expected rerun:     0 applied, 9 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_AASSIGN_PATH =
  "Omniflow/app/api/omniflow/portal/automations/autoassign/route.ts";

const CP_DB_PATH = "OmniFlow-Control-Plane/portal_db.py";
const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const CP_CONNECTOR_PATH = "OmniFlow-Control-Plane/connector_api.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/automations/page.tsx";

// --------------------------------------------------------------------------
// Control Plane: portal_db.py (lazy column)
// --------------------------------------------------------------------------

const DB_DDL_FROM = `ALTER TABLE portal_automation_settings
  ADD COLUMN IF NOT EXISTS close_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE portal_automation_settings
  ADD COLUMN IF NOT EXISTS close_after_hours INT NOT NULL DEFAULT 48;`;

const DB_DDL_TO = `ALTER TABLE portal_automation_settings
  ADD COLUMN IF NOT EXISTS close_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE portal_automation_settings
  ADD COLUMN IF NOT EXISTS close_after_hours INT NOT NULL DEFAULT 48;
ALTER TABLE portal_automation_settings
  ADD COLUMN IF NOT EXISTS assign_enabled BOOLEAN NOT NULL DEFAULT FALSE;`;

// --------------------------------------------------------------------------
// Control Plane: portal_conversations.py (endpoints + engine, tail append)
// --------------------------------------------------------------------------

const CP_TAIL_FROM = `                "Auto-closed " + str(len(closed)) + " idle chat(s).",
            )
        return len(closed)`;

const CP_TAIL_TO = `                "Auto-closed " + str(len(closed)) + " idle chat(s).",
            )
        return len(closed)


@bp.get("/automations/autoassign")
def get_autoassign_settings():
    """Current auto-assign setting (off until the merchant turns it on)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT assign_enabled FROM "
                    + portal_db._q(WELCOME_SETTINGS_TABLE) +
                    " WHERE client_id = %s LIMIT 1",
                    (client_id,),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "autoassign settings read")[0]), 503
    row = rows[0] if rows else {}
    return jsonify({
        "ok": True,
        "enabled": bool(row.get("assign_enabled")),
    }), 200


@bp.put("/automations/autoassign")
def save_autoassign_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enabled must be true or false."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(WELCOME_SETTINGS_TABLE) +
                    " (client_id, assign_enabled, updated_at)"
                    " VALUES (%s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " assign_enabled = EXCLUDED.assign_enabled,"
                    " updated_at = NOW()",
                    (client_id, enabled),
                )
                portal_db.log_action(
                    cur,
                    client_id,
                    "automation.autoassign_updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Auto-assign enabled (least-loaded teammate)."
                    if enabled else "Auto-assign disabled.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "autoassign settings save")[0]), 503
    return jsonify({"ok": True, "enabled": enabled}), 200


def auto_assign_new_chat(client_id, conversation_id, conn):
    """Assign a brand-new chat to the active teammate with fewest open chats.

    Deterministic least-loaded pick: subquery counts each member's currently
    open assigned conversations, ordered ascending, tie-break lowest team id.
    Returns the assigned email, or None when disabled / no active members.
    The caller owns the transaction and wraps this in try/except.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT assign_enabled FROM "
            + portal_db._q(WELCOME_SETTINGS_TABLE) +
            " WHERE client_id = %s LIMIT 1",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        if not rows or not rows[0].get("assign_enabled"):
            return None
        cur.execute(
            "SELECT tm.email, tm.name FROM "
            + portal_db._q(portal_db.TEAM_TABLE) + " tm"
            " WHERE tm.client_id = %s AND tm.status = 'active'"
            " ORDER BY ("
            " SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
            " oc WHERE oc.client_id = tm.client_id"
            " AND oc.assigned_to = tm.email AND oc.status = 'open'"
            " ) ASC, tm.id ASC LIMIT 1",
            (client_id,),
        )
        members = portal_db.rows(cur)
        if not members:
            return None
        email = str(members[0].get("email") or "").strip()
        if not email:
            return None
        cur.execute(
            "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
            " SET assigned_to = %s, updated_at = NOW()"
            " WHERE id = %s AND client_id = %s",
            (email, conversation_id, client_id),
        )
        portal_db.log_action(
            cur,
            client_id,
            "automation.auto_assigned",
            "system",
            None,
            conversation_id,
            "Auto-assigned to " + email + " (least loaded).",
        )
    return email`;

// --------------------------------------------------------------------------
// Control Plane: connector_api.py (hook after the welcome hook)
// --------------------------------------------------------------------------

const CONN_HOOK_FROM = `                    if conv and conv[0].get("is_new") and item.get("direction") == "in":
                        try:
                            portal_conversations.maybe_send_welcome(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["name"],
                                conn,
                            )
                        except Exception:
                            pass
                    inserted += 1`;

const CONN_HOOK_TO = `                    if conv and conv[0].get("is_new") and item.get("direction") == "in":
                        try:
                            portal_conversations.maybe_send_welcome(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["name"],
                                conn,
                            )
                        except Exception:
                            pass
                        try:
                            portal_conversations.auto_assign_new_chat(
                                tenant["client_id"],
                                conversation_id,
                                conn,
                            )
                        except Exception:
                            pass
                    inserted += 1`;

// --------------------------------------------------------------------------
// Website: lib/omniflow/portal.ts (inserted before the Growth banner)
// --------------------------------------------------------------------------

const LIB_GROWTH_BANNER = `// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------`;

const LIB_AASSIGN_BLOCK = `// ---------------------------------------------------------------------------
// Automations: auto-assign new chats (least-loaded teammate)
// ---------------------------------------------------------------------------

export interface AutoAssignSettings {
  enabled: boolean;
}

export type AutoAssignSaveResult =
  | { kind: "ok"; enabled: boolean }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getAutoAssign(
  accessToken: string
): Promise<AutoAssignSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoassign");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return { enabled: p.enabled === true };
}

export async function saveAutoAssign(
  accessToken: string,
  enabled: boolean
): Promise<AutoAssignSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoassign", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return { kind: "ok", enabled: p.enabled === true };
}

` + LIB_GROWTH_BANNER;

// --------------------------------------------------------------------------
// Website: BFF passthrough (new file, nested depth = six ups)
// --------------------------------------------------------------------------

const BFF_AASSIGN_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getAutoAssign,
  requirePortalAccessToken,
  saveAutoAssign,
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
    const data = await getAutoAssign(accessToken);
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

export async function PUT(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  const enabled =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).enabled === true
      : false;

  try {
    const result = await saveAutoAssign(accessToken, enabled);
    if (result.kind === "ok") {
      return safeJson({ ok: true, enabled: result.enabled }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Enabled must be true or false.",
          },
        },
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
`;

// --------------------------------------------------------------------------
// Website: Automations page (4 swaps)
// --------------------------------------------------------------------------

const PAGE_STATE_FROM = `  const [closeMessage, setCloseMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const mounted = useRef(true);`;

const PAGE_STATE_TO = `  const [closeMessage, setCloseMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [assignEnabled, setAssignEnabled] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMessage, setAssignMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const mounted = useRef(true);`;

const PAGE_EFFECT_FROM = `  useEffect(() => {
    void loadAutoClose();
  }, [loadAutoClose]);`;

const PAGE_EFFECT_TO = `  const loadAutoAssign = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/automations/autoassign", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        enabled?: boolean;
      } | null;
      if (payload) setAssignEnabled(payload.enabled === true);
    } catch {
      // Additive card — never block the page on it.
    }
  }, []);

  useEffect(() => {
    void loadAutoAssign();
  }, [loadAutoAssign]);

  useEffect(() => {
    void loadAutoClose();
  }, [loadAutoClose]);`;

const PAGE_SAVE_FROM = `  async function saveAutoClose() {`;

const PAGE_SAVE_TO = `  async function saveAutoAssign() {
    if (assignBusy) return;
    setAssignBusy(true);
    setAssignMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/automations/autoassign", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ enabled: assignEnabled }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setAssignMessage({ kind: "ok", text: "Auto-assign saved." });
      } else {
        setAssignMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setAssignMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setAssignBusy(false);
    }
  }

  async function saveAutoClose() {`;

const PAGE_CARD_FROM = `      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <p className="text-xs font-medium text-slate-300">
          When a message contains…
        </p>`;

const PAGE_CARD_TO = `      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-300">
              Auto-assign new chats
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">
              Every new chat goes straight to the teammate with the fewest
              open chats right now — fair spread, no manual triage.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAssignEnabled(!assignEnabled)}
            className={
              "shrink-0 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
              (assignEnabled
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                : "border-white/[0.08] bg-white/[0.03] text-slate-500")
            }
          >
            {assignEnabled ? "On" : "Off"}
          </button>
        </div>
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            onClick={() => void saveAutoAssign()}
            disabled={assignBusy}
            className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {assignBusy ? "Saving…" : "Save auto-assign"}
          </button>
        </div>
        {assignMessage && (
          <p
            className={
              "mt-2 text-xs " +
              (assignMessage.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {assignMessage.text}
          </p>
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <p className="text-xs font-medium text-slate-300">
          When a message contains…
        </p>`;

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------

const TARGETS = [
  {
    file: CP_DB_PATH,
    swaps: [
      { name: "db-aassign-column", from: DB_DDL_FROM, to: DB_DDL_TO },
    ],
  },
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-aassign-endpoints-engine", from: CP_TAIL_FROM, to: CP_TAIL_TO },
    ],
  },
  {
    file: CP_CONNECTOR_PATH,
    swaps: [
      { name: "connector-aassign-hook", from: CONN_HOOK_FROM, to: CONN_HOOK_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-aassign-block", from: LIB_GROWTH_BANNER, to: LIB_AASSIGN_BLOCK },
    ],
  },
  {
    file: PAGE_PATH,
    swaps: [
      { name: "page-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-load-aassign", from: PAGE_EFFECT_FROM, to: PAGE_EFFECT_TO },
      { name: "page-save-fn", from: PAGE_SAVE_FROM, to: PAGE_SAVE_TO },
      { name: "page-aassign-card", from: PAGE_CARD_FROM, to: PAGE_CARD_TO },
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

  const backup = target.file + ".pre_aassign.bak";
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
const NEW_FILES = [[BFF_AASSIGN_PATH, BFF_AASSIGN_FILE]];
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