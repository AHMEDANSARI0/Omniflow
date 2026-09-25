// add_widget_theme.mjs — Phase 14: Widget Customization v1 (theme + position).
//
// Completes the website-widget platform (zero AI, no bridge changes -> NO
// bot restart). Merchants can now theme the website chat bubble from the
// portal settings card:
// 1. Accent colour — 7 curated presets (cyan, violet, emerald, pink, amber,
//    rose, blue). Stored as #rrggbb, applied to the launcher, panel header
//    dot, visitor bubbles and send button.
// 2. Bubble position — bottom-left or bottom-right on desktop.
// 3. Launcher label — optional text next to the bubble icon ("Chat with us").
//
// New columns live on the same widget singleton (lazy ALTER TABLE ... IF NOT
// EXISTS), ride along in the public /widget/config payload and the
// authenticated GET/PUT /portal/widget/settings pair, and degrade to the
// current cyan/right/icon look whenever a value is missing or invalid.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_widget_theme.mjs
//
// Requires Phase 13 (add_saved_replies.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_theme.bak
// Expected first run: 23 applied, 0 warnings (23 swaps, no new files).
// Expected rerun:     0 applied, 23 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "widget theme columns DDL",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_saved_replies
  ON portal_saved_replies (client_id, id DESC);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_saved_replies
  ON portal_saved_replies (client_id, id DESC);
ALTER TABLE portal_widget_settings
  ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT '#22d3ee';
ALTER TABLE portal_widget_settings
  ADD COLUMN IF NOT EXISTS position TEXT NOT NULL DEFAULT 'right';
ALTER TABLE portal_widget_settings
  ADD COLUMN IF NOT EXISTS launcher_label TEXT NOT NULL DEFAULT '';
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_widget.py",
    swaps: [
      {
        name: "theme constants",
        from: `MAX_BUSINESS_NAME = 80
MAX_WELCOME_TEXT = 200`,
        to: `MAX_BUSINESS_NAME = 80
MAX_WELCOME_TEXT = 200
DEFAULT_ACCENT = "#22d3ee"
WIDGET_POSITIONS = ("left", "right")
MAX_LAUNCHER_LABEL = 24
DEFAULT_LAUNCHER_LABEL = "Chat with us"`,
      },
      {
        name: "widget client reads theme columns",
        from: `def _widget_client(cur) -> Optional[Dict[str, Any]]:
    """The widget settings singleton (row id = 1), seeded lazily from the
    first registered workspace so the widget works with zero setup."""
    cur.execute(
        "SELECT client_id, enabled, business_name, welcome_text FROM "
        + portal_db._q(WIDGET_TABLE) + " WHERE id = 1 LIMIT 1"
    )
    rows = portal_db.rows(cur)
    if rows:
        return rows[0]
    cur.execute(
        "SELECT MIN(client_id) AS client_id FROM "
        + portal_db._q(portal_db.USERS_TABLE)
    )
    seed = portal_db.rows(cur)
    client_id = seed[0].get("client_id") if seed else None
    if client_id is None:
        return None
    cur.execute(
        "INSERT INTO " + portal_db._q(WIDGET_TABLE) +
        " (id, client_id, enabled, business_name, welcome_text)"
        " VALUES (1, %s, TRUE, '', %s)"
        " ON CONFLICT (id) DO NOTHING",
        (client_id, DEFAULT_WELCOME),
    )
    cur.execute(
        "SELECT client_id, enabled, business_name, welcome_text FROM "
        + portal_db._q(WIDGET_TABLE) + " WHERE id = 1 LIMIT 1"
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None`,
        to: `def _widget_client(cur) -> Optional[Dict[str, Any]]:
    """The widget settings singleton (row id = 1), seeded lazily from the
    first registered workspace so the widget works with zero setup."""
    cur.execute(
        "SELECT client_id, enabled, business_name, welcome_text,"
        " accent, position, launcher_label FROM "
        + portal_db._q(WIDGET_TABLE) + " WHERE id = 1 LIMIT 1"
    )
    rows = portal_db.rows(cur)
    if rows:
        return rows[0]
    cur.execute(
        "SELECT MIN(client_id) AS client_id FROM "
        + portal_db._q(portal_db.USERS_TABLE)
    )
    seed = portal_db.rows(cur)
    client_id = seed[0].get("client_id") if seed else None
    if client_id is None:
        return None
    cur.execute(
        "INSERT INTO " + portal_db._q(WIDGET_TABLE) +
        " (id, client_id, enabled, business_name, welcome_text,"
        " accent, position, launcher_label)"
        " VALUES (1, %s, TRUE, '', %s, %s, 'right', '')"
        " ON CONFLICT (id) DO NOTHING",
        (client_id, DEFAULT_WELCOME, DEFAULT_ACCENT),
    )
    cur.execute(
        "SELECT client_id, enabled, business_name, welcome_text,"
        " accent, position, launcher_label FROM "
        + portal_db._q(WIDGET_TABLE) + " WHERE id = 1 LIMIT 1"
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None`,
      },
      {
        name: "public config carries theme",
        from: `    return jsonify({
        "enabled": True,
        "business_name": str(cfg.get("business_name") or ""),
        "welcome_text": str(cfg.get("welcome_text") or "") or DEFAULT_WELCOME,
    }), 200`,
        to: `    return jsonify({
        "enabled": True,
        "business_name": str(cfg.get("business_name") or ""),
        "welcome_text": str(cfg.get("welcome_text") or "") or DEFAULT_WELCOME,
        "accent": str(cfg.get("accent") or DEFAULT_ACCENT),
        "position": cfg.get("position")
        if cfg.get("position") in WIDGET_POSITIONS
        else "right",
        "launcher_label": str(cfg.get("launcher_label") or ""),
    }), 200`,
      },
      {
        name: "settings public carries theme",
        from: `def _settings_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "enabled": row.get("enabled") is True,
        "business_name": str(row.get("business_name") or ""),
        "welcome_text": str(row.get("welcome_text") or ""),
    }`,
        to: `def _settings_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "enabled": row.get("enabled") is True,
        "business_name": str(row.get("business_name") or ""),
        "welcome_text": str(row.get("welcome_text") or ""),
        "accent": str(row.get("accent") or DEFAULT_ACCENT),
        "position": row.get("position")
        if row.get("position") in WIDGET_POSITIONS
        else "right",
        "launcher_label": str(row.get("launcher_label") or ""),
    }`,
      },
      {
        name: "PUT validates theme fields",
        from: `    welcome_text = str(payload.get("welcome_text") or "").strip()
    if len(welcome_text) > MAX_WELCOME_TEXT:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Welcome text must be 200 characters or fewer."}}), 400`,
        to: `    welcome_text = str(payload.get("welcome_text") or "").strip()
    if len(welcome_text) > MAX_WELCOME_TEXT:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Welcome text must be 200 characters or fewer."}}), 400
    accent = str(payload.get("accent") or "").strip().lower()
    if not accent:
        accent = DEFAULT_ACCENT
    if not re.match(r"^#[0-9a-f]{6}$", accent):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Accent must be a hex colour like #22d3ee."}}), 400
    position = str(payload.get("position") or "right").strip().lower()
    if position not in WIDGET_POSITIONS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Position must be left or right."}}), 400
    launcher_label = re.sub(r"\\s+", " ", str(payload.get("launcher_label") or "").strip())
    if len(launcher_label) > MAX_LAUNCHER_LABEL:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Launcher label must be 24 characters or fewer."}}), 400`,
      },
      {
        name: "UPDATE persists theme",
        from: `                cur.execute(
                    "UPDATE " + portal_db._q(WIDGET_TABLE) +
                    " SET enabled = %s, business_name = %s, welcome_text = %s,"
                    " updated_at = NOW() WHERE id = 1",
                    (enabled, business_name, welcome_text),
                )`,
        to: `                cur.execute(
                    "UPDATE " + portal_db._q(WIDGET_TABLE) +
                    " SET enabled = %s, business_name = %s, welcome_text = %s,"
                    " accent = %s, position = %s, launcher_label = %s,"
                    " updated_at = NOW() WHERE id = 1",
                    (enabled, business_name, welcome_text, accent, position,
                     launcher_label),
                )`,
      },
      {
        name: "PUT response echoes theme",
        from: `    return jsonify({"ok": True, "settings": {
        "enabled": enabled,
        "business_name": business_name,
        "welcome_text": welcome_text,
    }}), 200`,
        to: `    return jsonify({"ok": True, "settings": {
        "enabled": enabled,
        "business_name": business_name,
        "welcome_text": welcome_text,
        "accent": accent,
        "position": position,
        "launcher_label": launcher_label,
    }}), 200`,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "WidgetSettings type + normalize",
        from: `export interface WidgetSettings {
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
}`,
        to: `export interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
  accent: string;
  position: "left" | "right";
  launcherLabel: string;
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
    accent:
      typeof settings.accent === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(settings.accent)
        ? settings.accent
        : "#22d3ee",
    position: settings.position === "left" ? "left" : "right",
    launcherLabel:
      typeof settings.launcher_label === "string" ? settings.launcher_label : "",
  };
}`,
      },
      {
        name: "saveWidgetSettings carries theme",
        from: `export async function saveWidgetSettings(
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
    });`,
        to: `export async function saveWidgetSettings(
  accessToken: string,
  settings: {
    enabled: boolean;
    businessName: string;
    welcomeText: string;
    accent: string;
    position: "left" | "right";
    launcherLabel: string;
  }
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
        accent: settings.accent,
        position: settings.position,
        launcher_label: settings.launcherLabel,
      }),
    });`,
      },
    ],
  },
  {
    file: "Omniflow/app/api/omniflow/portal/widget-settings/route.ts",
    swaps: [
      {
        name: "BFF payload type + theme validation",
        from: `  const payload = (await request.json().catch(() => null)) as {
    enabled?: unknown;
    businessName?: unknown;
    welcomeText?: unknown;
  } | null;`,
        to: `  const payload = (await request.json().catch(() => null)) as {
    enabled?: unknown;
    businessName?: unknown;
    welcomeText?: unknown;
    accent?: unknown;
    position?: unknown;
    launcherLabel?: unknown;
  } | null;`,
      },
      {
        name: "BFF theme guards + save call",
        from: `  if (welcomeText.length > 200) {
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
    });`,
        to: `  if (welcomeText.length > 200) {
    return safeJson(
      { error: { code: "bad_request", message: "Welcome text must be 200 characters or fewer." } },
      400
    );
  }
  const accent =
    typeof payload.accent === "string" ? payload.accent.trim().toLowerCase() : "";
  if (accent && !/^#[0-9a-f]{6}$/.test(accent)) {
    return safeJson(
      { error: { code: "bad_request", message: "Accent must be a hex colour like #22d3ee." } },
      400
    );
  }
  const rawPosition = typeof payload.position === "string" ? payload.position : "";
  const position = rawPosition === "left" ? "left" : "right";
  const launcherLabel =
    typeof payload.launcherLabel === "string"
      ? payload.launcherLabel.trim().slice(0, 24)
      : "";

  try {
    const ok = await saveWidgetSettings(accessToken, {
      enabled: payload.enabled,
      businessName,
      welcomeText,
      accent: accent || "#22d3ee",
      position,
      launcherLabel,
    });`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/settings/WidgetSettingsCard.tsx",
    swaps: [
      {
        name: "card interface theme fields",
        from: `interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
}`,
        to: `interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
  accent: string;
  position: "left" | "right";
  launcherLabel: string;
}

const ACCENT_PRESETS = [
  "#22d3ee",
  "#a78bfa",
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#fb7185",
  "#60a5fa",
];`,
      },
      {
        name: "card load maps theme",
        from: `      const payload = (await response.json().catch(() => null)) as {
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
      }`,
        to: `      const payload = (await response.json().catch(() => null)) as {
        settings?: {
          enabled?: boolean;
          businessName?: string;
          welcomeText?: string;
          accent?: string;
          position?: string;
          launcherLabel?: string;
        } | null;
      } | null;
      if (payload?.settings) {
        setSettings({
          enabled: payload.settings.enabled === true,
          businessName: payload.settings.businessName ?? "",
          welcomeText: payload.settings.welcomeText ?? "",
          accent: payload.settings.accent ?? "#22d3ee",
          position: payload.settings.position === "left" ? "left" : "right",
          launcherLabel: payload.settings.launcherLabel ?? "",
        });
      }`,
      },
      {
        name: "card save sends theme",
        from: `        body: JSON.stringify({
          enabled: next.enabled,
          businessName: next.businessName.trim(),
          welcomeText: next.welcomeText.trim(),
        }),`,
        to: `        body: JSON.stringify({
          enabled: next.enabled,
          businessName: next.businessName.trim(),
          welcomeText: next.welcomeText.trim(),
          accent: next.accent,
          position: next.position,
          launcherLabel: next.launcherLabel.trim(),
        }),`,
      },
      {
        name: "card appearance controls",
        from: `          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => save(settings)}
              disabled={busy}
              className={primaryBtn + " w-full sm:w-auto"}
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>`,
        to: `          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Accent colour
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-label={"Accent colour " + preset}
                  onClick={() => setSettings({ ...settings, accent: preset })}
                  className={
                    "h-8 w-8 rounded-full border-2 transition-transform duration-150 " +
                    (settings.accent.toLowerCase() === preset
                      ? "scale-110 border-white"
                      : "border-white/20 hover:scale-105")
                  }
                  style={{ backgroundColor: preset }}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Bubble position (desktop)
            </label>
            <div className="flex gap-2">
              {(["left", "right"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSettings({ ...settings, position: value })}
                  className={
                    "rounded-xl border px-4 py-2 text-xs font-medium capitalize transition-colors duration-300 " +
                    (settings.position === value
                      ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                      : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:text-white")
                  }
                >
                  {value === "left" ? "Bottom left" : "Bottom right"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Launcher label (optional)
            </label>
            <input
              value={settings.launcherLabel}
              onChange={(event) =>
                setSettings({ ...settings, launcherLabel: event.target.value })
              }
              maxLength={24}
              placeholder="Chat with us"
              className={inputClass}
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
          </div>`,
      },
    ],
  },
  {
    file: "Omniflow/app/components/WebsiteChatWidget.tsx",
    swaps: [
      {
        name: "widget config interface theme",
        from: `interface WidgetConfig {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
}`,
        to: `interface WidgetConfig {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
  accent: string;
  position: "left" | "right";
  launcherLabel: string;
}`,
      },
      {
        name: "widget config parse theme",
        from: `        const payload = (await response.json().catch(() => null)) as {
          enabled?: boolean;
          business_name?: string;
          welcome_text?: string;
        } | null;
        if (alive && payload?.enabled) {
          setConfig({
            enabled: true,
            businessName: payload.business_name ?? "",
            welcomeText: payload.welcome_text ?? "",
          });
        }`,
        to: `        const payload = (await response.json().catch(() => null)) as {
          enabled?: boolean;
          business_name?: string;
          welcome_text?: string;
          accent?: string;
          position?: string;
          launcher_label?: string;
        } | null;
        if (alive && payload?.enabled) {
          setConfig({
            enabled: true,
            businessName: payload.business_name ?? "",
            welcomeText: payload.welcome_text ?? "",
            accent:
              typeof payload.accent === "string" &&
              /^#[0-9a-fA-F]{6}$/.test(payload.accent)
                ? payload.accent
                : "#22d3ee",
            position: payload.position === "left" ? "left" : "right",
            launcherLabel:
              typeof payload.launcher_label === "string"
                ? payload.launcher_label
                : "",
          });
        }`,
      },
      {
        name: "panel position dynamic",
        from: `          className="fixed inset-x-3 bottom-3 top-20 z-50 flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#060f1b] shadow-2xl shadow-black/40 sm:inset-x-auto sm:bottom-20 sm:right-5 sm:top-auto sm:h-[540px] sm:w-96"`,
        to: `          className={
            "fixed inset-x-3 bottom-3 top-20 z-50 flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#060f1b] shadow-2xl shadow-black/40 sm:inset-x-auto sm:bottom-20 sm:top-auto sm:h-[540px] sm:w-96 " +
            (config.position === "left" ? "sm:left-5" : "sm:right-5")
          }`,
      },
      {
        name: "header dot accent",
        from: `              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/[0.06]">
                <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.7)]" />
              </span>`,
        to: `              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{
                  border: "1px solid " + config.accent + "33",
                  backgroundColor: config.accent + "0F",
                }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: config.accent,
                    boxShadow: "0 0 12px " + config.accent + "B3",
                  }}
                />
              </span>`,
      },
      {
        name: "visitor bubble accent",
        from: `                      (message.direction === "in"
                        ? "rounded-br-md border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-50"
                        : "rounded-bl-md border border-white/[0.06] bg-white/[0.03] text-slate-200")
                    }`,
        to: `                      (message.direction === "in"
                        ? "rounded-br-md border text-slate-50"
                        : "rounded-bl-md border border-white/[0.06] bg-white/[0.03] text-slate-200")
                    }
                    style={
                      message.direction === "in"
                        ? {
                            borderColor: config.accent + "33",
                            backgroundColor: config.accent + "14",
                          }
                        : undefined
                    }`,
      },
      {
        name: "composer neutral focus + accent send",
        from: `            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={1000}
              placeholder="Type your message…"
              className="min-w-0 flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.1] px-4 py-2.5 text-xs font-semibold text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.18] disabled:opacity-50"
            >
              {busy ? "…" : "Send"}
            </button>`,
        to: `            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={1000}
              placeholder="Type your message…"
              className="min-w-0 flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-white/30"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="shrink-0 rounded-xl border px-4 py-2.5 text-xs font-semibold transition-colors duration-300 disabled:opacity-50"
              style={{
                borderColor: config.accent + "40",
                backgroundColor: config.accent + "1A",
                color: config.accent,
              }}
            >
              {busy ? "…" : "Send"}
            </button>`,
      },
      {
        name: "launcher accent + position + label",
        from: `      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close chat" : "Open chat"}
        className="fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-400 text-lg text-[#07111f] shadow-xl shadow-cyan-500/20 transition-transform duration-200 hover:scale-105"
      >
        {open ? "✕" : "❖"}
      </button>`,
        to: `      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close chat" : "Open chat"}
        className={
          "fixed bottom-5 z-50 flex items-center justify-center gap-2 border text-lg text-[#07111f] shadow-xl transition-transform duration-200 hover:scale-105 " +
          (config.position === "left" ? "left-5" : "right-5") +
          (!open && config.launcherLabel
            ? " h-12 rounded-full px-4 text-sm font-semibold"
            : " h-12 w-12 rounded-full")
        }
        style={{
          borderColor: config.accent + "4D",
          backgroundColor: config.accent,
          boxShadow: "0 10px 30px " + config.accent + "33",
        }}
      >
        <span aria-hidden>{open ? "✕" : "❖"}</span>
        {!open && config.launcherLabel ? (
          <span>{config.launcherLabel}</span>
        ) : null}
      </button>`,
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

  const backup = target.file + ".pre_theme.bak";
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
