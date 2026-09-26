// add_batch_101_105.mjs - one-file batch covering Phases 101-105.
//
//   Ph101  Business-hours storage + endpoints in the control plane
//          (lazy client_settings JSONB table, GET/PUT /portal/business-hours)
//   Ph102  lib types + getBusinessHours/updateBusinessHours + BFF route
//   Ph103  BusinessHoursCard on the settings page (7-day editor, away
//          message, live Open now / Closed now pill in the saved timezone)
//   Ph104  The thread sidebar cards load via next/dynamic (smaller initial JS)
//   Ph105  Inbox poll interval 10s -> 15s (33% less background CP load)
//
// Away-message ENFORCEMENT on the WhatsApp connector ships separately (it
// lives in the laptop bot repo); this batch delivers config + visibility.
// No AI. CP deploy is automatic on push (Vercel). No restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PATH = "Omniflow/lib/omniflow/portal.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const DETAIL_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";
const SETTINGS_PAGE_PATH = "Omniflow/app/dashboard/(portal)/settings/page.tsx";
const BFF_ROUTE_PATH = "Omniflow/app/api/omniflow/portal/business-hours/route.ts";
const CARD_PATH = "Omniflow/app/dashboard/(portal)/settings/BusinessHoursCard.tsx";

const NEW_FILES = [
  {
    path: BFF_ROUTE_PATH,
    marker: "business_hours",
    content: `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getBusinessHours,
  requirePortalAccessToken,
  updateBusinessHours,
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
    const data = await getBusinessHours(accessToken);
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      400
    );
  }
  try {
    const result = await updateBusinessHours(
      accessToken,
      (body as { business_hours?: unknown }).business_hours
    );
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "rejected") {
      return safeJson(
        { error: { code: "bad_request", message: result.message } },
        400
      );
    }
    return safeJson({ ok: true, business_hours: result.business_hours }, 200);
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
`,
  },
  {
    path: CARD_PATH,
    marker: "Business hours",
    content: `"use client";

import { useCallback, useEffect, useState } from "react";

interface BusinessHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}

interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  days: BusinessHoursDay[];
  away_message: string;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULT_CONFIG: BusinessHoursConfig = {
  enabled: false,
  timezone: "Asia/Karachi",
  days: DAY_LABELS.map(() => ({ enabled: true, start: "09:00", end: "17:00" })),
  away_message:
    "Thanks for your message! Our team is currently offline. We will reply during business hours.",
};

function isOpenNow(config: BusinessHoursConfig): boolean {
  if (!config.enabled) return true;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date());
    const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
    const day = config.days[DAY_LABELS.indexOf(weekday)];
    if (!day || !day.enabled) return false;
    const now = hour.padStart(2, "0") + ":" + minute;
    return now >= day.start && now <= day.end;
  } catch {
    return true;
  }
}

export default function BusinessHoursCard() {
  const [config, setConfig] = useState<BusinessHoursConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/business-hours", {
        credentials: "same-origin",
      });
      const payload = (await response.json()) as {
        business_hours?: BusinessHoursConfig;
      };
      if (payload.business_hours) setConfig(payload.business_hours);
    } catch {
      // Transient network issue, the card can be reloaded.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patchDay(index: number, patch: Partial<BusinessHoursDay>) {
    setConfig((current) => {
      if (!current) return current;
      const days = current.days.map((day, dayIndex) =>
        dayIndex === index ? { ...day, ...patch } : day
      );
      return { ...current, days };
    });
  }

  async function save() {
    if (!config || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/business-hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ business_hours: config }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (response.ok && payload.ok) {
        setNotice("Business hours saved.");
      } else {
        setNotice(payload.error?.message ?? "The save did not go through.");
      }
    } catch {
      setNotice("The save did not go through. Check the connection.");
    } finally {
      setBusy(false);
    }
  }

  if (!config) {
    return (
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
        <h2 className="text-sm font-semibold text-white">Business hours</h2>
        <p className="mt-2 text-xs text-slate-600">Loading…</p>
      </section>
    );
  }

  const open = isOpenNow(config);

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Business hours</h2>
        {config.enabled && (
          <span
            className={
              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider " +
              (open
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                : "border-amber-400/25 bg-amber-400/[0.08] text-amber-300")
            }
          >
            {open ? "Open now" : "Closed now"}
          </span>
        )}
      </div>
      <label className="mt-4 flex items-center gap-3 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) =>
            setConfig({ ...config, enabled: event.target.checked })
          }
          className="h-4 w-4 accent-cyan-400"
        />
        Enabled outside these hours, show an away message to customers
      </label>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">
          Timezone (IANA name)
          <input
            value={config.timezone}
            onChange={(event) =>
              setConfig({ ...config, timezone: event.target.value })
            }
            className="mt-1 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
        </label>
        <label className="block text-xs text-slate-400">
          Away message
          <textarea
            value={config.away_message}
            onChange={(event) =>
              setConfig({ ...config, away_message: event.target.value })
            }
            rows={3}
            maxLength={500}
            className="mt-1 w-full resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
        </label>
      </div>
      <div className="mt-4 space-y-2">
        {config.days.map((day, index) => (
          <div
            key={DAY_LABELS[index]}
            className="flex items-center gap-3 text-xs text-slate-300"
          >
            <input
              type="checkbox"
              checked={day.enabled}
              onChange={(event) =>
                patchDay(index, { enabled: event.target.checked })
              }
              className="h-4 w-4 accent-cyan-400"
            />
            <span className="w-10 font-medium">{DAY_LABELS[index]}</span>
            <input
              type="time"
              value={day.start}
              disabled={!day.enabled}
              onChange={(event) => patchDay(index, { start: event.target.value })}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-xs text-white outline-none disabled:opacity-40"
            />
            <span className="text-slate-600">to</span>
            <input
              type="time"
              value={day.end}
              disabled={!day.enabled}
              onChange={(event) => patchDay(index, { end: event.target.value })}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-xs text-white outline-none disabled:opacity-40"
            />
          </div>
        ))}
      </div>
      {notice && <p className="mt-3 text-[11px] text-amber-300">{notice}</p>}
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="mt-4 rounded-xl bg-cyan-400 px-5 py-2 text-xs font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save business hours"}
      </button>
    </section>
  );
}
`,
  },
];

const CP_BUSINESS_HOURS_FROM = `@bp.post("/conversations/read-all")`;

const CP_BUSINESS_HOURS_TO = `import json

_DEFAULT_BUSINESS_HOURS = {
    "enabled": False,
    "timezone": "Asia/Karachi",
    "days": [
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
    ],
    "away_message": "Thanks for your message! Our team is currently offline. We will reply during business hours.",
}

_SETTINGS_TABLE_READY = False


def _ensure_settings_table() -> None:
    global _SETTINGS_TABLE_READY
    if _SETTINGS_TABLE_READY:
        return
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS " + portal_db._q("client_settings") +
                " (client_id BIGINT PRIMARY KEY, settings JSONB NOT NULL DEFAULT '{}'::jsonb,"
                " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
            )
        conn.commit()
    finally:
        conn.close()
    _SETTINGS_TABLE_READY = True


def _validate_business_hours(config) -> list:
    problems = []
    if not isinstance(config, dict):
        return ["business_hours must be an object."]
    if not isinstance(config.get("enabled"), bool):
        problems.append("enabled must be a boolean.")
    timezone = config.get("timezone")
    if not isinstance(timezone, str) or not timezone or len(timezone) > 64:
        problems.append("timezone must be a short string.")
    days = config.get("days")
    if not isinstance(days, list) or len(days) != 7:
        problems.append("days must list all seven days.")
    else:
        for day in days:
            if not isinstance(day, dict) or not isinstance(day.get("enabled"), bool):
                problems.append("each day needs an enabled flag.")
                break
            for field in ("start", "end"):
                value = day.get(field)
                if (
                    not isinstance(value, str)
                    or len(value) != 5
                    or value[2] != ":"
                    or not value[:2].isdigit()
                    or not value[3:].isdigit()
                ):
                    problems.append("day times must be HH:MM.")
                    break
    message = config.get("away_message")
    if not isinstance(message, str) or len(message) > 500:
        problems.append("away_message must be at most 500 characters.")
    return problems


@bp.get("/business-hours")
def get_business_hours():
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        _ensure_settings_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT settings -> 'business_hours' AS business_hours FROM " +
                    portal_db._q("client_settings") +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "business hours")[0]), 503

    stored = rows[0].get("business_hours") if rows and rows[0] else None
    config = stored if isinstance(stored, dict) else _DEFAULT_BUSINESS_HOURS
    return jsonify({"business_hours": config}), 200


@bp.put("/business-hours")
def update_business_hours():
    principal, error = _principal_or_error()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    config = payload.get("business_hours")
    problems = _validate_business_hours(config)
    if problems:
        return jsonify({"error": {"code": "bad_request", "message": " ".join(problems)}}), 400

    try:
        _ensure_settings_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q("client_settings") +
                    " (client_id, settings) VALUES (%s, %s::jsonb)"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " settings = client_settings.settings || EXCLUDED.settings,"
                    " updated_at = NOW()",
                    (principal["client_id"], json.dumps({"business_hours": config})),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "business_hours.update",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Business hours updated.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "business hours update")[0]), 503
    return jsonify({"ok": True, "business_hours": config}), 200


@bp.post("/conversations/read-all")`;

const LIB_BUSINESS_HOURS_FROM = `export async function markAllConversationsRead(`;

const LIB_BUSINESS_HOURS_TO = `export interface BusinessHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}

export interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  days: BusinessHoursDay[];
  away_message: string;
}

export async function getBusinessHours(
  accessToken: string
): Promise<{ business_hours: BusinessHoursConfig } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/business-hours", {});
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    business_hours?: BusinessHoursConfig;
  } | null;
  if (!payload || !payload.business_hours) return null;
  return { business_hours: payload.business_hours };
}

export async function updateBusinessHours(
  accessToken: string,
  config: unknown
): Promise<
  { kind: "ok"; business_hours: BusinessHoursConfig } | { kind: "rejected"; message: string } | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_hours: config }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      kind: "rejected",
      message: payload?.error?.message ?? "Invalid business hours.",
    };
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    business_hours?: BusinessHoursConfig;
  } | null;
  if (!payload || !payload.business_hours) return null;
  return { kind: "ok", business_hours: payload.business_hours };
}

export async function markAllConversationsRead(`;

const SETTINGS_IMPORT_FROM = `import ApiKeyCard from "./ApiKeyCard";`;

const SETTINGS_IMPORT_TO = `import ApiKeyCard from "./ApiKeyCard";
import BusinessHoursCard from "./BusinessHoursCard";`;

const SETTINGS_RENDER_FROM = `      <ApiKeyCard keyInfo={keyInfo} />`;

const SETTINGS_RENDER_TO = `      <ApiKeyCard keyInfo={keyInfo} />
      <BusinessHoursCard />`;

const DETAIL_DYNAMIC_IMPORT_FROM = `import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import CodCard from "./CodCard";
import TeamCard from "./TeamCard";
import TagsCard from "./TagsCard";
import NotesCard from "./NotesCard";
import RatingCard from "./RatingCard";
import CustomerCard from "./CustomerCard";
import SavedRepliesPicker from "./SavedRepliesPicker";`;

const DETAIL_DYNAMIC_IMPORT_TO = `import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

const CodCard = dynamic(() => import("./CodCard"));
const TeamCard = dynamic(() => import("./TeamCard"));
const TagsCard = dynamic(() => import("./TagsCard"));
const NotesCard = dynamic(() => import("./NotesCard"));
const RatingCard = dynamic(() => import("./RatingCard"));
const CustomerCard = dynamic(() => import("./CustomerCard"));
const SavedRepliesPicker = dynamic(() => import("./SavedRepliesPicker"));`;

const INBOX_POLL_FROM = `const POLL_MS = 10_000;`;

const INBOX_POLL_TO = `const POLL_MS = 15_000;`;

// Driver

const TARGETS = [
  {
    file: CP_PATH,
    swaps: [
      { name: "cp-business-hours", from: CP_BUSINESS_HOURS_FROM, to: CP_BUSINESS_HOURS_TO },
    ],
  },
  {
    file: LIB_PATH,
    swaps: [
      { name: "lib-business-hours", from: LIB_BUSINESS_HOURS_FROM, to: LIB_BUSINESS_HOURS_TO },
    ],
  },
  {
    file: SETTINGS_PAGE_PATH,
    swaps: [
      { name: "settings-import", from: SETTINGS_IMPORT_FROM, to: SETTINGS_IMPORT_TO },
      { name: "settings-render", from: SETTINGS_RENDER_FROM, to: SETTINGS_RENDER_TO },
    ],
  },
  {
    file: DETAIL_PAGE_PATH,
    swaps: [
      { name: "p104-dynamic-cards", from: DETAIL_DYNAMIC_IMPORT_FROM, to: DETAIL_DYNAMIC_IMPORT_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "p105-poll-ms", from: INBOX_POLL_FROM, to: INBOX_POLL_TO },
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
    if (fs.readFileSync(file.path, "utf8").includes(file.marker)) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + file.path + " exists without the expected marker — report this");
    }
    continue;
  }
  writeFileEnsuringDir(file.path, file.content);
  appliedTotal++;
  console.log("+ NEW " + file.path);
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

  const backup = target.file + ".pre_b101105.bak";
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