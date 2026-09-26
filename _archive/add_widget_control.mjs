// add_widget_control.mjs — Phase 11: Widget Control + Channel Filters v0.
//
// Completes the Phase-10 website chat widget with portal-side control:
// 1. Widget settings (Settings page card): turn the website chat bubble ON
//    or OFF, set the business name shown in the widget header and edit the
//    welcome text — saved through a new authenticated endpoint pair
//    (GET/PUT /portal/widget/settings, API keys stay read-only, audit
//    widget.updated). The public widget picks the change up instantly.
// 2. Channel filters: the conversations list gets All channels / WhatsApp /
//    Website segmented chips; the Control Plane list endpoint accepts a
//    channel param so mixed-channel inboxes stay manageable.
//
// Zero AI cost, no bridge changes -> NO bot restart.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_widget_control.mjs
//
// Requires Phase 10 (add_website_chat.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_ctrl.bak
// Expected first run: 13 applied / 0 warnings (11 swaps + 2 new files).
// Expected rerun:     0 applied / 11 already done / 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const WIDGET_SETTINGS_CARD_PATH =
  "Omniflow/app/dashboard/(portal)/settings/WidgetSettingsCard.tsx";
const BFF_WIDGET_SETTINGS_PATH =
  "Omniflow/app/api/omniflow/portal/widget-settings/route.ts";

const BFF_WIDGET_SETTINGS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getWidgetSettings,
  requirePortalAccessToken,
  saveWidgetSettings,
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
    const data = await getWidgetSettings(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ settings: data }, 200);
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
    enabled?: unknown;
    businessName?: unknown;
    welcomeText?: unknown;
  } | null;
  if (typeof payload?.enabled !== "boolean") {
    return safeJson(
      { error: { code: "bad_request", message: "enabled must be true or false." } },
      400
    );
  }
  const businessName =
    typeof payload.businessName === "string" ? payload.businessName.trim() : "";
  const welcomeText =
    typeof payload.welcomeText === "string" ? payload.welcomeText.trim() : "";
  if (businessName.length > 80) {
    return safeJson(
      { error: { code: "bad_request", message: "Business name must be 80 characters or fewer." } },
      400
    );
  }
  if (welcomeText.length > 200) {
    return safeJson(
      { error: { code: "bad_request", message: "Welcome text must be 200 characters or fewer." } },
      400
    );
  }

  try {
    const ok = await saveWidgetSettings(accessToken, {
      enabled: payload.enabled,
      businessName,
      welcomeText,
    });
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
`;

const WIDGET_SETTINGS_APPEND = `


# ---------------------------------------------------------------------------
# Portal-side widget settings (authenticated humans; API keys stay read-only)
# ---------------------------------------------------------------------------

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

MAX_BUSINESS_NAME = 80
MAX_WELCOME_TEXT = 200


def _settings_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "enabled": row.get("enabled") is True,
        "business_name": str(row.get("business_name") or ""),
        "welcome_text": str(row.get("welcome_text") or ""),
    }


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


@bp.get("/portal/widget/settings")
def portal_widget_settings_get():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cfg = _widget_client(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "widget settings")[0]), 503
    if not cfg or cfg.get("client_id") is None:
        return jsonify({"error": {"code": "no_workspace",
                                  "message": "No workspace found."}}), 400
    return jsonify({"settings": _settings_public(cfg)}), 200


@bp.put("/portal/widget/settings")
def portal_widget_settings_put():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "enabled must be true or false."}}), 400
    business_name = re.sub(r"\\s+", " ", str(payload.get("business_name") or "").strip())
    if len(business_name) > MAX_BUSINESS_NAME:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Business name must be 80 characters or fewer."}}), 400
    welcome_text = str(payload.get("welcome_text") or "").strip()
    if len(welcome_text) > MAX_WELCOME_TEXT:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Welcome text must be 200 characters or fewer."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cfg = _widget_client(cur)
                if not cfg or cfg.get("client_id") is None:
                    return jsonify({"error": {"code": "no_workspace",
                                              "message": "No workspace found."}}), 400
                cur.execute(
                    "UPDATE " + portal_db._q(WIDGET_TABLE) +
                    " SET enabled = %s, business_name = %s, welcome_text = %s,"
                    " updated_at = NOW() WHERE id = 1",
                    (enabled, business_name, welcome_text),
                )
                portal_db.log_action(
                    cur,
                    cfg["client_id"],
                    "widget.updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Website widget " + ("enabled." if enabled else "disabled."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "widget settings update")[0]), 503
    return jsonify({"ok": True, "settings": {
        "enabled": enabled,
        "business_name": business_name,
        "welcome_text": welcome_text,
    }}), 200
`;

const PORTAL_TS_WIDGET_SETTINGS_SECTION = `// ---------------------------------------------------------------------------
// Website widget settings
// ---------------------------------------------------------------------------

export interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
}

function normalizeWidgetSettings(value: unknown): WidgetSettings | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const settings = (p.settings !== undefined ? p.settings : p) as Record<string, unknown>;
  return {
    enabled: settings.enabled === true,
    businessName:
      typeof settings.business_name === "string" ? settings.business_name : "",
    welcomeText:
      typeof settings.welcome_text === "string" ? settings.welcome_text : "",
  };
}

export async function getWidgetSettings(
  accessToken: string
): Promise<WidgetSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/widget/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return normalizeWidgetSettings(payload);
}

export async function saveWidgetSettings(
  accessToken: string,
  settings: { enabled: boolean; businessName: string; welcomeText: string }
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/widget/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: settings.enabled,
        business_name: settings.businessName,
        welcome_text: settings.welcomeText,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export type ConversationStatusResult =`;

const WIDGET_SETTINGS_CARD_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
}

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

export default function WidgetSettingsCard() {
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/widget-settings", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        settings?: {
          enabled?: boolean;
          businessName?: string;
          welcomeText?: string;
        } | null;
      } | null;
      if (payload?.settings) {
        setSettings({
          enabled: payload.settings.enabled === true,
          businessName: payload.settings.businessName ?? "",
          welcomeText: payload.settings.welcomeText ?? "",
        });
      }
      setLoaded(true);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: WidgetSettings) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/widget-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          enabled: next.enabled,
          businessName: next.businessName.trim(),
          welcomeText: next.welcomeText.trim(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setSettings(next);
        setMessage({
          kind: "ok",
          text: next.enabled
            ? "Saved — the website chat bubble updates right away."
            : "Saved — the website chat bubble is now hidden.",
        });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded && !loadError) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <div className="h-4 w-40 animate-pulse rounded bg-white/[0.05]" />
        <div className="mt-3 h-10 animate-pulse rounded bg-white/[0.03]" />
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-6 text-center">
        <p className="text-sm text-slate-300">
          The widget control is rolling out on the server — try again in a
          couple of minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-white">
              Website chat widget
            </h2>
            <span
              className={
                "rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                (settings.enabled
                  ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                  : "border-white/[0.08] bg-white/[0.03] text-slate-500")
              }
            >
              {settings.enabled ? "Live" : "Off"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            Visitors chat from your website straight into the same inbox —
            replies reach them inside the widget, never on WhatsApp.
          </p>
        </div>
        <button
          type="button"
          onClick={() => save({ ...settings, enabled: !settings.enabled })}
          disabled={busy}
          className={
            "w-full shrink-0 rounded-xl px-4 py-2 text-xs font-medium transition-colors duration-300 disabled:opacity-50 sm:w-auto " +
            (settings.enabled
              ? "border border-red-400/25 bg-red-400/[0.06] text-red-300 hover:bg-red-400/[0.12]"
              : "border border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300 hover:bg-emerald-400/[0.14]")
          }
        >
          {settings.enabled ? "Disable widget" : "Enable widget"}
        </button>
      </div>

      {settings.enabled && (
        <div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Business name (widget header)
            </label>
            <input
              value={settings.businessName}
              onChange={(event) =>
                setSettings({ ...settings, businessName: event.target.value })
              }
              maxLength={80}
              placeholder="e.g. Ahmed Collection"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Welcome message
            </label>
            <textarea
              value={settings.welcomeText}
              onChange={(event) =>
                setSettings({ ...settings, welcomeText: event.target.value })
              }
              rows={2}
              maxLength={200}
              placeholder="Hi! Message us here and we will reply right away."
              className={inputClass + " resize-none"}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => save(settings)}
              disabled={busy}
              className={primaryBtn + " w-full sm:w-auto"}
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={
            "mt-3 text-xs " +
            (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_widget.py",
    swaps: [
      {
        name: "authenticated widget settings endpoints",
        from: `    return jsonify({
        "conversation_id": conversation_id,
        "messages": [_message_public(m) for m in messages],
    }), 200`,
        to: `    return jsonify({
        "conversation_id": conversation_id,
        "messages": [_message_public(m) for m in messages],
    }), 200
` + WIDGET_SETTINGS_APPEND,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "list endpoint channel filter",
        from: `    intent_filter = (request.args.get("intent") or "").strip().lower()
    if intent_filter and intent_filter != "all":
        sql += " AND c.last_intent = %s"
        params.append(intent_filter[:40])`,
        to: `    intent_filter = (request.args.get("intent") or "").strip().lower()
    if intent_filter and intent_filter != "all":
        sql += " AND c.last_intent = %s"
        params.append(intent_filter[:40])
    channel_filter = (request.args.get("channel") or "").strip().lower()
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)`,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "listConversations channel param",
        from: `export async function listConversations(
  accessToken: string,
  searchQuery?: string,
  statusFilter?: string,
  intentFilter?: string
): Promise<ConversationSummary[] | null> {`,
        to: `export async function listConversations(
  accessToken: string,
  searchQuery?: string,
  statusFilter?: string,
  intentFilter?: string,
  channelFilter?: string
): Promise<ConversationSummary[] | null> {`,
      },
      {
        name: "listConversations query builds channel part",
        from: `  const intentPart =
    intentFilter && intentFilter !== "all"
      ? "intent=" + encodeURIComponent(intentFilter)
      : "";
  const parts = [searchPart, statusPart, intentPart].filter(Boolean);`,
        to: `  const intentPart =
    intentFilter && intentFilter !== "all"
      ? "intent=" + encodeURIComponent(intentFilter)
      : "";
  const channelPart =
    channelFilter && channelFilter !== "all"
      ? "channel=" + encodeURIComponent(channelFilter)
      : "";
  const parts = [searchPart, statusPart, intentPart, channelPart].filter(Boolean);`,
      },
      {
        name: "widget settings client functions",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_WIDGET_SETTINGS_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/conversations/route.ts",
    swaps: [
      {
        name: "BFF passes channel filter through",
        from: `    const intentParam = url.searchParams.get("intent");
    const intentFilter =
      intentParam && intentParam !== "all"
        ? intentParam.toLowerCase().slice(0, 40)
        : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter
    );`,
        to: `    const intentParam = url.searchParams.get("intent");
    const intentFilter =
      intentParam && intentParam !== "all"
        ? intentParam.toLowerCase().slice(0, 40)
        : undefined;
    const channelParam = url.searchParams.get("channel");
    const channelFilter =
      channelParam === "whatsapp" || channelParam === "website"
        ? channelParam
        : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter
    );`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/settings/page.tsx",
    swaps: [
      {
        name: "import widget settings card",
        from: `import ApiKeyCard from "./ApiKeyCard";`,
        to: `import ApiKeyCard from "./ApiKeyCard";
import WidgetSettingsCard from "./WidgetSettingsCard";`,
      },
      {
        name: "mount widget settings card",
        from: `      <ApiKeyCard keyInfo={keyInfo} />
    </div>`,
        to: `      <ApiKeyCard keyInfo={keyInfo} />
      <div className="mt-6">
        <WidgetSettingsCard />
      </div>
    </div>`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "channel filter state",
        from: `  const [intentFilter, setIntentFilter] = useState("all");
  const intentRef = useRef("all");`,
        to: `  const [intentFilter, setIntentFilter] = useState("all");
  const intentRef = useRef("all");
  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "website">("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");`,
      },
      {
        name: "refresh passes channel param",
        from: `      if (intentRef.current !== "all") listParams.set("intent", intentRef.current);`,
        to: `      if (intentRef.current !== "all") listParams.set("intent", intentRef.current);
      if (channelRef.current !== "all") listParams.set("channel", channelRef.current);`,
      },
      {
        name: "channel chips row above status chips",
        from: `      <div className="mb-4 flex items-center gap-2">
        {(["all", "open", "closed"] as const).map((value) => (`,
        to: `      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["all", "whatsapp", "website"] as const).map((value) => (
          <button
            key={"channel-" + value}
            onClick={() => {
              channelRef.current = value;
              setChannelFilter(value);
              void refresh();
            }}
            className={\`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors \${
              channelFilter === value
                ? "border-violet-400/30 bg-violet-400/[0.08] text-violet-200"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
            }\`}
          >
            {value === "all" ? "All channels" : value}
          </button>
        ))}
      </div>

      <div className="mb-4 flex items-center gap-2">
        {(["all", "open", "closed"] as const).map((value) => (`,
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

  const backup = target.file + ".pre_ctrl.bak";
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
  [BFF_WIDGET_SETTINGS_PATH, BFF_WIDGET_SETTINGS_FILE],
  [WIDGET_SETTINGS_CARD_PATH, WIDGET_SETTINGS_CARD_FILE],
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