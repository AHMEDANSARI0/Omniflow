// add_welcome_automation.mjs — Phase 20: Welcome Automation (new-chat greeting).
//
// Zero AI, no bridge process changes -> NO bot restart. WATI-style flagship:
// when a customer messages for the FIRST time (brand-new conversation), the
// merchant's greeting is queued instantly through the existing connector
// command queue. Reuses Phase 17 patterns: deterministic, configurable in the
// Automations page, audited.
//
//   - CP: new lazy-DDL table portal_automation_settings (one row per client:
//     welcome_enabled + welcome_text, 500-char cap). GET/PUT
//     /portal/automations/welcome (human session writes, audited).
//   - Engine: connector_api upsert now returns (xmax = 0) AS is_new; when a
//     WhatsApp ingest item CREATED the conversation and direction == "in",
//     maybe_send_welcome() reads the settings and queues one send_message
//     command ({{name}} -> first name or "there"). Existing chats never
//     re-trigger; ingest retries never duplicate (row already exists).
//   - Website: portal.ts get/save + BFF automations/welcome/route.ts +
//     "Welcome message" card (On/Off toggle + textarea + save) at the top of
//     the Automations page.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_welcome_automation.mjs
//
// Requires Phase 19 (add_overview_command_center.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_wlcm.bak
// Expected first run: 12 applied, 0 warnings (11 swaps + 1 new file).
// Expected rerun:     0 applied, 12 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_WELCOME_PATH =
  "Omniflow/app/api/omniflow/portal/automations/welcome/route.ts";

const CP_DB_PATH = "OmniFlow-Control-Plane/portal_db.py";
const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const CP_CONNECTOR_PATH = "OmniFlow-Control-Plane/connector_api.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/automations/page.tsx";

// --------------------------------------------------------------------------
// Control Plane: portal_db.py (const + lazy DDL)
// --------------------------------------------------------------------------

const DB_CONST_FROM = `AUTOMATIONS_TABLE = os.environ.get("OF_AUTOMATIONS_TABLE", "portal_automations")`;

const DB_CONST_TO = `AUTOMATIONS_TABLE = os.environ.get("OF_AUTOMATIONS_TABLE", "portal_automations")
AUTOMATION_SETTINGS_TABLE = os.environ.get(
    "OF_AUTOMSETTINGS_TABLE", "portal_automation_settings"
)`;

const DB_DDL_FROM = `CREATE TABLE IF NOT EXISTS portal_widget_settings (
  id INT PRIMARY KEY,
  client_id BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  business_name TEXT NOT NULL DEFAULT '',
  welcome_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

const DB_DDL_TO = `CREATE TABLE IF NOT EXISTS portal_widget_settings (
  id INT PRIMARY KEY,
  client_id BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  business_name TEXT NOT NULL DEFAULT '',
  welcome_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_automation_settings (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL UNIQUE,
  welcome_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  welcome_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

// --------------------------------------------------------------------------
// Control Plane: portal_conversations.py (const + endpoints + engine)
// --------------------------------------------------------------------------

const CP_CONST_FROM = `AUTOMATIONS_TABLE = portal_db.AUTOMATIONS_TABLE`;

const CP_CONST_TO = `AUTOMATIONS_TABLE = portal_db.AUTOMATIONS_TABLE
WELCOME_SETTINGS_TABLE = portal_db.AUTOMATION_SETTINGS_TABLE`;

const CP_TAIL_FROM = `    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "automation delete")[0]), 503
    return jsonify({"ok": True}), 200`;

const CP_TAIL_TO = `    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "automation delete")[0]), 503
    return jsonify({"ok": True}), 200


@bp.get("/automations/welcome")
def get_welcome_settings():
    """Current welcome-automation settings (defaults when never configured)."""
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
                    "SELECT welcome_enabled, welcome_text FROM "
                    + portal_db._q(WELCOME_SETTINGS_TABLE) +
                    " WHERE client_id = %s LIMIT 1",
                    (client_id,),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "welcome settings read")[0]), 503
    row = rows[0] if rows else {}
    return jsonify({
        "ok": True,
        "enabled": bool(row.get("welcome_enabled")),
        "text": str(row.get("welcome_text") or ""),
    }), 200


@bp.put("/automations/welcome")
def save_welcome_settings():
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
    text = payload.get("text")
    text = text.strip() if isinstance(text, str) else ""
    if enabled and not text:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Write the welcome message first."}}), 400
    if len(text) > 500:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Welcome message must be 500 characters or fewer."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(WELCOME_SETTINGS_TABLE) +
                    " (client_id, welcome_enabled, welcome_text, updated_at)"
                    " VALUES (%s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " welcome_enabled = EXCLUDED.welcome_enabled,"
                    " welcome_text = EXCLUDED.welcome_text,"
                    " updated_at = NOW()",
                    (client_id, enabled, text),
                )
                portal_db.log_action(
                    cur,
                    client_id,
                    "automation.welcome_updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Welcome automation " + ("enabled." if enabled else "disabled."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "welcome settings save")[0]), 503
    return jsonify({"ok": True, "enabled": enabled, "text": text}), 200


def maybe_send_welcome(client_id, conversation_id, contact_id, contact_name, conn):
    """Queue the welcome message for a brand-new WhatsApp conversation.

    Called from the ingest path only when the conversation row was created by
    the current message (the upsert's (xmax = 0) flag). Deterministic: one
    settings read, at most one queued send_message command. Returns True when
    a welcome was queued. The caller wraps this in try/except.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT welcome_enabled, welcome_text FROM "
            + portal_db._q(WELCOME_SETTINGS_TABLE) +
            " WHERE client_id = %s LIMIT 1",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        if not rows or not rows[0].get("welcome_enabled"):
            return False
        text = str(rows[0].get("welcome_text") or "").strip()
        if not text:
            return False
        display = str(contact_name or "").strip()
        first_name = display.split(" ")[0] if display else ""
        greeting = text.replace("{{name}}", first_name or "there")
        greeting_payload = {
            "external_user_id": contact_id,
            "body": greeting[:1000],
            "source": "welcome",
        }
        if display:
            greeting_payload["target_display_name"] = display
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
            " (client_id, channel, action, payload, status, requested_by,"
            " created_at, updated_at) "
            "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
            " 'pending', NULL, NOW(), NOW()) "
            "RETURNING id",
            (client_id, json.dumps(greeting_payload)),
        )
        portal_db.log_action(
            cur,
            client_id,
            "automation.welcome_sent",
            "system",
            None,
            conversation_id,
            "Welcome message queued for a new conversation.",
        )
    return True`;

// --------------------------------------------------------------------------
// Control Plane: connector_api.py (is_new flag + welcome hook)
// --------------------------------------------------------------------------

const CONN_RETURNING_FROM = `                        " updated_at = NOW() "
                        "RETURNING id",
                        (tenant["client_id"], item["from"], item["name"], item["body"],
                         item["intent"]),`;

const CONN_RETURNING_TO = `                        " updated_at = NOW() "
                        "RETURNING id, (xmax = 0) AS is_new",
                        (tenant["client_id"], item["from"], item["name"], item["body"],
                         item["intent"]),`;

const CONN_HOOK_FROM = `                    try:
                        portal_conversations.apply_automation_rules(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["body"],
                            conn,
                        )
                    except Exception:
                        pass
                    inserted += 1`;

const CONN_HOOK_TO = `                    try:
                        portal_conversations.apply_automation_rules(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["body"],
                            conn,
                        )
                    except Exception:
                        pass
                    if conv and conv[0].get("is_new") and item.get("direction") == "in":
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

// --------------------------------------------------------------------------
// Website: lib/omniflow/portal.ts (inserted before the Growth banner)
// --------------------------------------------------------------------------

const LIB_GROWTH_BANNER = `// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------`;

const LIB_WELCOME_BLOCK = `// ---------------------------------------------------------------------------
// Automations: welcome message (new-conversation greeting)
// ---------------------------------------------------------------------------

export interface WelcomeAutomationSettings {
  enabled: boolean;
  text: string;
}

export type WelcomeSaveResult =
  | { kind: "ok"; enabled: boolean; text: string }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getWelcomeAutomation(
  accessToken: string
): Promise<WelcomeAutomationSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/welcome");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    enabled: p.enabled === true,
    text: typeof p.text === "string" ? p.text : "",
  };
}

export async function saveWelcomeAutomation(
  accessToken: string,
  enabled: boolean,
  text: string
): Promise<WelcomeSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/welcome", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, text }),
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
  return { kind: "ok", enabled: p.enabled === true, text: typeof p.text === "string" ? p.text : "" };
}

` + LIB_GROWTH_BANNER;

// --------------------------------------------------------------------------
// Website: BFF passthrough (new file, nested depth = six ups)
// --------------------------------------------------------------------------

const BFF_WELCOME_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  getWelcomeAutomation,
  requirePortalAccessToken,
  saveWelcomeAutomation,
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
    const data = await getWelcomeAutomation(accessToken);
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
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const enabled = body.enabled === true;
  const text = typeof body.text === "string" ? body.text : "";

  try {
    const result = await saveWelcomeAutomation(accessToken, enabled, text);
    if (result.kind === "ok") {
      return safeJson({ ok: true, enabled: result.enabled, text: result.text }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Write the welcome message first (500 characters max).",
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

const PAGE_STATE_FROM = `  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );
  const mounted = useRef(true);`;

const PAGE_STATE_TO = `  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );
  const [welcomeEnabled, setWelcomeEnabled] = useState(false);
  const [welcomeText, setWelcomeText] = useState("");
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const mounted = useRef(true);`;

const PAGE_EFFECT_FROM = `  useEffect(() => {
    mounted.current = true;
    void load();`;

const PAGE_EFFECT_TO = `  const loadWelcome = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/automations/welcome", {
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
        text?: string;
      } | null;
      if (payload) {
        setWelcomeEnabled(payload.enabled === true);
        setWelcomeText(typeof payload.text === "string" ? payload.text : "");
      }
    } catch {
      // Additive card — never block the page on it.
    }
  }, []);

  useEffect(() => {
    void loadWelcome();
  }, [loadWelcome]);

  useEffect(() => {
    mounted.current = true;
    void load();`;

const PAGE_SAVE_FROM = `  async function addRule() {`;

const PAGE_SAVE_TO = `  async function saveWelcome() {
    if (welcomeBusy) return;
    setWelcomeBusy(true);
    setWelcomeMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/automations/welcome", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ enabled: welcomeEnabled, text: welcomeText.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setWelcomeMessage({ kind: "ok", text: "Welcome message saved." });
      } else {
        setWelcomeMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setWelcomeMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setWelcomeBusy(false);
    }
  }

  async function addRule() {`;

const PAGE_CARD_FROM = `      <p className="mt-0.5 text-xs text-slate-500">
        Simple keyword rules that run instantly on every incoming message —
        WhatsApp and website. No AI, fully deterministic.
      </p>

      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <p className="text-xs font-medium text-slate-300">
          When a message contains…
        </p>`;

const PAGE_CARD_TO = `      <p className="mt-0.5 text-xs text-slate-500">
        Simple keyword rules that run instantly on every incoming message —
        WhatsApp and website. No AI, fully deterministic.
      </p>

      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-300">Welcome message</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">
              Sent automatically when a customer messages for the first time.
              Use {"{{name}}"} to greet by first name.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setWelcomeEnabled(!welcomeEnabled)}
            className={
              "shrink-0 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
              (welcomeEnabled
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                : "border-white/[0.08] bg-white/[0.03] text-slate-500")
            }
          >
            {welcomeEnabled ? "On" : "Off"}
          </button>
        </div>
        <textarea
          value={welcomeText}
          onChange={(event) => setWelcomeText(event.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Hi! Thanks for reaching out — how can we help you today?"
          className="mt-3 w-full resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] text-slate-600">
            {welcomeText.trim().length}/500
          </span>
          <button
            type="button"
            onClick={() => void saveWelcome()}
            disabled={welcomeBusy || (welcomeEnabled && !welcomeText.trim())}
            className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {welcomeBusy ? "Saving…" : "Save welcome message"}
          </button>
        </div>
        {welcomeMessage && (
          <p
            className={
              "mt-2 text-xs " +
              (welcomeMessage.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {welcomeMessage.text}
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
      { name: "db-const", from: DB_CONST_FROM, to: DB_CONST_TO },
      { name: "db-ddl", from: DB_DDL_FROM, to: DB_DDL_TO },
    ],
  },
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-const", from: CP_CONST_FROM, to: CP_CONST_TO },
      { name: "cp-welcome-endpoints", from: CP_TAIL_FROM, to: CP_TAIL_TO },
    ],
  },
  {
    file: CP_CONNECTOR_PATH,
    swaps: [
      { name: "connector-is-new-flag", from: CONN_RETURNING_FROM, to: CONN_RETURNING_TO },
      { name: "connector-welcome-hook", from: CONN_HOOK_FROM, to: CONN_HOOK_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-welcome-block", from: LIB_GROWTH_BANNER, to: LIB_WELCOME_BLOCK },
    ],
  },
  {
    file: PAGE_PATH,
    swaps: [
      { name: "page-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-load-welcome", from: PAGE_EFFECT_FROM, to: PAGE_EFFECT_TO },
      { name: "page-save-fn", from: PAGE_SAVE_FROM, to: PAGE_SAVE_TO },
      { name: "page-welcome-card", from: PAGE_CARD_FROM, to: PAGE_CARD_TO },
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

  const backup = target.file + ".pre_wlcm.bak";
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
const NEW_FILES = [[BFF_WELCOME_PATH, BFF_WELCOME_FILE]];
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