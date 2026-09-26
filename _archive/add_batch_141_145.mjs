// add_batch_141_145.mjs - one-file batch covering Phases 141-145.
//
//   Ph141  NEW control-plane module portal_setup.py: GET
//          /api/v1/portal/setup/status - one read-only call that checks
//          the seven setup milestones (WhatsApp connected, business hours
//          saved, away replies on, knowledge base started, customers in,
//          first broadcast sent, COD confirmations on). Optional tables
//          are probed with to_regclass so fresh databases never error.
//   Ph142  app.py registers the blueprint (anchors on the cod lines).
//   Ph143  portal lib SetupStatus + getSetupStatus + BFF setup route.
//   Ph144  Overview page: a SetupChecklist card right under the welcome
//          header - progress bar, seven linked items with checkmarks,
//          an "all set" state that stays out of the way once done.
//   Ph145  Regression coverage.
//
// Zero AI, zero bridge changes, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SETUP_MODULE = `"""Setup progress: which onboarding milestones this client has reached."""

import logging
from typing import Any

from flask import Blueprint, jsonify

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db

bp = Blueprint("portal_setup", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)


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


def _table_exists(cur, name: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS oid", (name,))
    found = portal_db.rows(cur)
    return bool(found and found[0].get("oid"))


@bp.get("/setup/status")
def setup_status():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = principal["client_id"]
    checks: dict = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT state FROM " + portal_db._q(portal_db.STATUS_TABLE) +
                    " WHERE client_id = %s",
                    (client_id,),
                )
                found = portal_db.rows(cur)
                checks["whatsapp"] = bool(found) and found[0].get("state") == "connected"

                cur.execute(
                    "SELECT settings->'business_hours' AS bh FROM client_settings"
                    " WHERE client_id = %s",
                    (client_id,),
                )
                found = portal_db.rows(cur)
                bh = found[0].get("bh") if found else None
                checks["hours"] = bh is not None
                checks["away"] = isinstance(bh, dict) and bh.get("enabled") is True

                checks["kb"] = False
                if _table_exists(cur, "portal_kb_entries"):
                    cur.execute(
                        "SELECT COUNT(*) AS total FROM " + portal_db._q("portal_kb_entries") +
                        " WHERE client_id = %s",
                        (client_id,),
                    )
                    found = portal_db.rows(cur)
                    checks["kb"] = bool(found) and int(found[0].get("total") or 0) > 0

                cur.execute(
                    "SELECT COUNT(*) AS total FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s",
                    (client_id,),
                )
                found = portal_db.rows(cur)
                checks["customers"] = bool(found) and int(found[0].get("total") or 0) > 0

                checks["broadcast"] = False
                if _table_exists(cur, "portal_broadcasts"):
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q("portal_broadcasts") +
                        " WHERE client_id = %s LIMIT 1",
                        (client_id,),
                    )
                    checks["broadcast"] = bool(portal_db.rows(cur))

                checks["cod"] = False
                if _table_exists(cur, "portal_cod_settings"):
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q("portal_cod_settings") +
                        " WHERE client_id = %s AND enabled IS TRUE LIMIT 1",
                        (client_id,),
                    )
                    checks["cod"] = bool(portal_db.rows(cur))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("setup status read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "setup status read")[0]), 503
    return jsonify({"setup": {"checks": checks}}), 200
`;

const APP_IMPORT_FROM = `from portal_cod import bp as portal_cod_bp  # noqa: E402`;
const APP_IMPORT_TO = `from portal_cod import bp as portal_cod_bp  # noqa: E402
from portal_setup import bp as portal_setup_bp  # noqa: E402`;

const APP_REGISTER_FROM = `aux_app.register_blueprint(portal_cod_bp)`;
const APP_REGISTER_TO = `aux_app.register_blueprint(portal_cod_bp)
aux_app.register_blueprint(portal_setup_bp)`;

const PORTAL_TS_FROM = `export type ConversationStatusResult =`;

const PORTAL_TS_TO = `export interface SetupStatus {
  whatsapp: boolean;
  hours: boolean;
  away: boolean;
  kb: boolean;
  customers: boolean;
  broadcast: boolean;
  cod: boolean;
}

export async function getSetupStatus(
  accessToken: string
): Promise<SetupStatus | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/setup/status");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).setup;
  if (raw === null || typeof raw !== "object") return null;
  const checks = ((raw as Record<string, unknown>).checks ?? {}) as Record<string, unknown>;
  const flag = (key: string) => checks[key] === true;
  return {
    whatsapp: flag("whatsapp"),
    hours: flag("hours"),
    away: flag("away"),
    kb: flag("kb"),
    customers: flag("customers"),
    broadcast: flag("broadcast"),
    cod: flag("cod"),
  };
}

export type ConversationStatusResult =`;

const BFF_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getSetupStatus,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const setup = await getSetupStatus(accessToken);
    if (setup === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Setup status is not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ setup }, 200);
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
`;

const CHECKLIST_FILE = `"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface SetupFlags {
  whatsapp: boolean;
  hours: boolean;
  away: boolean;
  kb: boolean;
  customers: boolean;
  broadcast: boolean;
  cod: boolean;
}

const ITEMS: { key: keyof SetupFlags; label: string; hint: string; href: string }[] = [
  {
    key: "whatsapp",
    label: "Connect your WhatsApp number",
    hint: "Scan the QR from the connector laptop",
    href: "/dashboard/channels/whatsapp",
  },
  {
    key: "hours",
    label: "Set your business hours",
    hint: "Powers away replies and the thread banner",
    href: "/dashboard/settings",
  },
  {
    key: "away",
    label: "Turn on away replies",
    hint: "Customers get an instant reply outside hours",
    href: "/dashboard/settings",
  },
  {
    key: "kb",
    label: "Add knowledge base answers",
    hint: "FAQs the assistant can use verbatim",
    href: "/dashboard/knowledge-base",
  },
  {
    key: "customers",
    label: "Bring customers in",
    hint: "Chats, or a CSV import from the Customers page",
    href: "/dashboard/customers",
  },
  {
    key: "broadcast",
    label: "Send your first broadcast",
    hint: "One message to a whole audience",
    href: "/dashboard/broadcasts",
  },
  {
    key: "cod",
    label: "Enable COD confirmations",
    hint: "Cut returns on cash-on-delivery orders",
    href: "/dashboard/cod",
  },
];

export default function SetupChecklist() {
  const [flags, setFlags] = useState<SetupFlags | null>(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/setup", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const setup = (payload as { setup?: SetupFlags }).setup;
        if (setup) setFlags(setup);
      }
    } catch {
      /* the card simply stays hidden on failure */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!flags || hidden) return null;

  const doneCount = ITEMS.filter((item) => flags[item.key]).length;
  const total = ITEMS.length;
  const percent = Math.round((doneCount / total) * 100);

  return (
    <div className="mb-8 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.03] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Setup progress</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {doneCount === total
              ? "All set \\u2014 every feature is configured."
              : String(doneCount) + " of " + String(total) + " steps done"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
        >
          Recheck
        </button>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={
            "h-full rounded-full transition-all duration-500 " +
            (doneCount === total ? "bg-emerald-400/70" : "bg-cyan-400/70")
          }
          style={{ width: String(percent) + "%" }}
        />
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {ITEMS.map((item) => {
          const done = flags[item.key];
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                className={
                  "flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors duration-300 " +
                  (done
                    ? "border-emerald-400/15 bg-emerald-400/[0.04]"
                    : "border-white/[0.06] bg-white/[0.01] hover:border-cyan-400/25")
                }
              >
                <span
                  className={
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] " +
                    (done
                      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-300"
                      : "border-white/15 text-slate-600")
                  }
                  aria-hidden
                >
                  {done ? "\\u2713" : ""}
                </span>
                <span className="min-w-0">
                  <span
                    className={
                      "block text-sm " + (done ? "text-slate-400 line-through" : "text-slate-200")
                    }
                  >
                    {item.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-600">
                    {item.hint}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
`;

const PAGE_IMPORT_FROM = `import { readSessionCookies } from "../../../lib/omniflow/session-cookies";`;
const PAGE_IMPORT_TO = `import { readSessionCookies } from "../../../lib/omniflow/session-cookies";
import SetupChecklist from "../components/SetupChecklist";`;

const PAGE_RENDER_FROM = `          Your tenant-isolated OmniFlow workspace is authenticated and ready.
        </p>
      </div>`;

const PAGE_RENDER_TO = `          Your tenant-isolated OmniFlow workspace is authenticated and ready.
        </p>
      </div>

      <SetupChecklist />`;

const NEW_FILES = [
  { path: "OmniFlow-Control-Plane/portal_setup.py", content: SETUP_MODULE, marker: "setup_status", name: "p141-setup-module" },
  { path: "Omniflow/app/api/omniflow/portal/setup/route.ts", content: BFF_FILE, marker: "getSetupStatus", name: "p143-bff-setup" },
  { path: "Omniflow/app/dashboard/components/SetupChecklist.tsx", content: CHECKLIST_FILE, marker: "Setup progress", name: "p144-checklist" },
];

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      { name: "p142-app-import", from: APP_IMPORT_FROM, to: APP_IMPORT_TO, guard: "portal_setup" },
      { name: "p142-app-register", from: APP_REGISTER_FROM, to: APP_REGISTER_TO, guard: "register_blueprint(portal_setup_bp)" },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      { name: "p143-portal-lib", from: PORTAL_TS_FROM, to: PORTAL_TS_TO, guard: "getSetupStatus" },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/page.tsx",
    swaps: [
      { name: "p144-page-import", from: PAGE_IMPORT_FROM, to: PAGE_IMPORT_TO, guard: 'from "../components/SetupChecklist"' },
      { name: "p144-page-render", from: PAGE_RENDER_FROM, to: PAGE_RENDER_TO, guard: "<SetupChecklist />" },
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

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content.replace(/\r\n/g, "\n"), "utf8");
  if (file.path.endsWith(".py") && !compilePython(file.path)) {
    fs.rmSync(file.path);
    warnTotal++;
    console.log("FAIL (compile failed): " + file.path);
    continue;
  }
  appliedTotal++;
  console.log("+ " + file.path + " (new): " + file.name);
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

  const backup = target.file + ".pre_b141145.bak";
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