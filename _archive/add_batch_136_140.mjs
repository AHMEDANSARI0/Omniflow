// add_batch_136_140.mjs - one-file batch covering Phases 136-140.
//
//   Ph136  POST /portal/customers/import: up to 300 rows of {name, phone}
//          per request. Pakistani phone numbers are normalized
//          (0092/92/0/3xxx -> 92xxxxxxxxxx) and upserted as WhatsApp
//          conversations (contact_id = 92xxx@c.us) via ON CONFLICT -
//          new rows count as created, existing ones as merged, bad
//          numbers come back as invalid with row numbers. Audited.
//   Ph137  GET /portal/customers/export: the FULL customer list (up to
//          2000, not just the loaded page) as a CSV download.
//   Ph138  BFF routes for both (import POST, export CSV passthrough).
//   Ph139  Customers page: an "Import CSV" button + dialog (client-side
//          CSV parse, phone/name column sniffing, preview, result note)
//          next to the existing Export button.
//   Ph140  Regression coverage.
//
// Imported customers immediately work with broadcasts, COD confirmations
// and every other audience feature. Zero AI. CP + website, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";

const FLASK_IMPORT_FROM = `from flask import Blueprint, jsonify, request`;
const FLASK_IMPORT_TO = `import csv
import io

from flask import Blueprint, jsonify, request, Response`;

const AUTH_IMPORT_FROM = `from portal_auth import authenticate_portal_request`;
const AUTH_IMPORT_TO = `from portal_auth import authenticate_portal_request, ensure_human_principal`;

const IMPORT_BLOCK_FROM = `@bp.get("/customers")`;

const IMPORT_BLOCK_TO = `def _normalize_pk_phone(raw: str):
    """Normalize PK numbers to 92xxxxxxxxxx; None when unusable."""
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if digits.startswith("0092"):
        digits = digits[4:]
    elif digits.startswith("92"):
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10 and digits.startswith("3"):
        digits = "92" + digits
    if len(digits) < 10 or len(digits) > 12 or not digits.startswith("92"):
        return None
    if len(digits) != 12:
        return None
    return digits


@bp.post("/customers/import")
def import_customers():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    rows = payload.get("customers")
    if not isinstance(rows, list) or not rows:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "customers list is required."}}), 400
    if len(rows) > 300:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Import at most 300 customers per request."}}), 400
    prepared = {}
    invalid = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            invalid.append({"row": index + 1, "reason": "not an object"})
            continue
        name = str(row.get("name") or "").strip()[:120]
        phone = _normalize_pk_phone(row.get("phone"))
        if phone is None:
            invalid.append({"row": index + 1, "reason": "unusable phone number"})
            continue
        prepared.setdefault(phone, name)
    created = 0
    merged = 0
    if prepared:
        try:
            portal_db.ensure_tables()
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    for phone, name in prepared.items():
                        cur.execute(
                            "INSERT INTO " + portal_db._q(portal_db.CONV_TABLE) +
                            " (client_id, channel, contact_id, contact_name, status)"
                            " VALUES (%s, 'whatsapp', %s, %s, 'open')"
                            " ON CONFLICT (client_id, channel, contact_id) DO UPDATE"
                            " SET contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''),"
                            " " + portal_db._q(portal_db.CONV_TABLE) + ".contact_name),"
                            " updated_at = NOW()"
                            " RETURNING (xmax = 0) AS created",
                            (principal["client_id"], phone + "@c.us", name),
                        )
                        outcome = portal_db.rows(cur)
                        if outcome and outcome[0].get("created"):
                            created += 1
                        else:
                            merged += 1
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "customers.imported",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "CSV import: " + str(created) + " new, "
                        + str(merged) + " merged, "
                        + str(len(invalid)) + " invalid.",
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception as error:
            return jsonify(portal_db.portal_unavailable(error, "customers import")[0]), 503
    return jsonify({"created": created, "merged": merged,
                    "invalid": invalid[:20], "invalid_count": len(invalid)}), 200


@bp.get("/customers/export")
def export_customers_csv():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT c.contact_id,"
                    " COALESCE(MAX(c.contact_name), '') AS name,"
                    " COUNT(*) AS conversations,"
                    " COUNT(*) FILTER (WHERE c.status = 'open') AS open_count,"
                    " COALESCE(BOOL_OR(c.lead_temp = 'hot'), FALSE) AS has_hot,"
                    " MAX(c.last_message_at) AS last_message_at"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
                    " WHERE c.client_id = %s"
                    " GROUP BY c.contact_id"
                    " ORDER BY MAX(c.last_message_at) DESC NULLS LAST, c.contact_id"
                    " LIMIT 2000",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customers export")[0]), 503
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["contact_id", "name", "conversations", "open_chats",
                     "hot_lead", "last_message_at"])
    for row in found:
        writer.writerow([
            row.get("contact_id"),
            row.get("name"),
            row.get("conversations"),
            row.get("open_count"),
            "yes" if row.get("has_hot") else "no",
            row.get("last_message_at").isoformat() if row.get("last_message_at") else "",
        ])
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=omniflow-customers.csv"},
    )


@bp.get("/customers")`;

const BFF_IMPORT_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  importCustomers,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const customers =
    payload !== null && typeof payload === "object"
      ? (payload as { customers?: unknown }).customers
      : null;
  if (!Array.isArray(customers)) {
    return safeJson(
      { error: { code: "bad_request", message: "customers list is required." } },
      400
    );
  }

  try {
    const result = await importCustomers(
      accessToken,
      customers as { name?: string; phone: string }[]
    );
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
`;

const BFF_EXPORT_FILE = `import {
  exportCustomersCsv,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
} from "../../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  }

  try {
    const csv = await exportCustomersCsv(accessToken);
    if (csv === null) {
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
      });
    }
    return new Response(csv, {
      status: 200,
      headers: {
        ...noStoreHeaders(),
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=omniflow-customers.csv",
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
  }
}
`;

const IMPORT_COMPONENT_FILE = `"use client";

import { useCallback, useRef, useState } from "react";

interface ImportResult {
  created: number;
  merged: number;
  invalid: { row: number; reason: string }[];
  invalid_count: number;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      current.push(field);
      field = "";
    } else if (ch === "\\n") {
      current.push(field.replace(/\\r$/, ""));
      field = "";
      if (current.some((cell) => cell.trim().length > 0)) rows.push(current);
      current = [];
    } else {
      field += ch;
    }
  }
  current.push(field.replace(/\\r$/, ""));
  if (current.some((cell) => cell.trim().length > 0)) rows.push(current);
  return rows;
}

export default function CustomersImport({
  onImported,
}: {
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<{ name: string; phone: string }[]>([]);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setNote("");
    setResult(null);
    setFileName(file.name);
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      setNoteTone("amber");
      setNote("The file needs a header row plus at least one customer.");
      setPreview([]);
      return;
    }
    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    let phoneIdx = header.findIndex((cell) => /phone|number|mobile|whats/.test(cell));
    let nameIdx = header.findIndex((cell) => /name|naam/.test(cell));
    if (phoneIdx === -1 && header.length >= 2) {
      nameIdx = 0;
      phoneIdx = 1;
    } else if (phoneIdx === -1) {
      phoneIdx = 0;
      nameIdx = -1;
    }
    const mapped = rows
      .slice(1)
      .map((row) => ({
        name: nameIdx >= 0 ? (row[nameIdx] || "").trim() : "",
        phone: (row[phoneIdx] || "").trim(),
      }))
      .filter((row) => row.phone.length > 0);
    if (mapped.length === 0) {
      setNoteTone("amber");
      setNote("No phone numbers found in the file.");
      setPreview([]);
      return;
    }
    if (mapped.length > 300) {
      setNoteTone("amber");
      setNote(mapped.length + " rows found - only the first 300 import per request.");
    }
    setPreview(mapped.slice(0, 300));
  }, []);

  const submit = useCallback(async () => {
    if (preview.length === 0) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/customers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customers: preview }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || payload === null || typeof payload !== "object") {
        setNoteTone("amber");
        setNote("Import failed. Try again shortly.");
        return;
      }
      const summary = payload as ImportResult;
      setResult(summary);
      setNoteTone("emerald");
      setNote(
        "Imported: " + summary.created + " new, " + summary.merged + " merged"
        + (summary.invalid_count > 0 ? ", " + summary.invalid_count + " invalid" : "")
        + "."
      );
      onImported?.();
    } catch {
      setNoteTone("amber");
      setNote("Import failed. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }, [preview, onImported]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setNote("");
          setResult(null);
          setPreview([]);
          setFileName("");
          if (fileRef.current) fileRef.current.value = "";
        }}
        className="ml-auto rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white"
      >
        Import CSV
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#0b1626] p-5">
            <h2 className="text-sm font-semibold text-white">Import customers</h2>
            <p className="mt-1 text-xs text-slate-500">
              Pick a CSV with name and phone columns. Pakistani numbers in any
              format work (0300…, 92 300…, +92 300…). Up to 300 per import.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
              className="mt-3 block w-full cursor-pointer rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-slate-300 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-cyan-400/15 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-cyan-200"
            />
            {fileName ? (
              <p className="mt-1.5 text-[11px] text-slate-500">
                {fileName} - {preview.length} customer{preview.length === 1 ? "" : "s"} ready.
              </p>
            ) : null}

            {preview.length > 0 ? (
              <ul className="mt-3 max-h-36 space-y-1 overflow-y-auto rounded-xl border border-white/[0.06] bg-white/[0.015] p-2.5">
                {preview.slice(0, 8).map((row, index) => (
                  <li key={String(index)} className="flex justify-between gap-2 text-[11px] text-slate-400">
                    <span className="truncate">{row.name || "(no name)"}</span>
                    <span className="shrink-0 font-mono">{row.phone}</span>
                  </li>
                ))}
                {preview.length > 8 ? (
                  <li className="text-[11px] text-slate-600">
                    + {preview.length - 8} more
                  </li>
                ) : null}
              </ul>
            ) : null}

            {note ? (
              <p
                className={
                  "mt-3 text-xs " +
                  (noteTone === "emerald" ? "text-emerald-300" : "text-amber-300")
                }
              >
                {note}
              </p>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || preview.length === 0}
                className="rounded-lg bg-cyan-400/15 px-4 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-40"
              >
                {busy ? "Importing\\u2026" : "Import " + preview.length}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
`;

const PAGE_TOOLBAR_FROM = `        <button
          type="button"
          onClick={() => exportCustomers()}`;

const PAGE_TOOLBAR_TO = `        <CustomersImport onImported={() => void refresh()} />
        <button
          type="button"
          onClick={() => exportCustomers()}`;

const PAGE_IMPORT_FROM = `import Link from "next/link";`;
const PAGE_IMPORT_TO = `import Link from "next/link";
import CustomersImport from "./CustomersImport";`;

const NEW_FILES = [
  { path: "Omniflow/app/api/omniflow/portal/customers/import/route.ts", content: BFF_IMPORT_FILE, marker: "importCustomers", name: "p138-bff-import" },
  { path: "Omniflow/app/api/omniflow/portal/customers/export/route.ts", content: BFF_EXPORT_FILE, marker: "exportCustomersCsv", name: "p138-bff-export" },
  { path: "Omniflow/app/dashboard/(portal)/customers/CustomersImport.tsx", content: IMPORT_COMPONENT_FILE, marker: "Import customers", name: "p139-import-component" },
];

const PORTAL_TS_FROM = `export type ConversationStatusResult =`;

const PORTAL_TS_TO = `export interface ImportedCustomerRow {
  name?: string;
  phone: string;
}

export interface CustomerImportResult {
  created: number;
  merged: number;
  invalid: { row: number; reason: string }[];
  invalid_count: number;
}

export async function importCustomers(
  accessToken: string,
  customers: ImportedCustomerRow[]
): Promise<CustomerImportResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customers }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    created: typeof p.created === "number" ? p.created : 0,
    merged: typeof p.merged === "number" ? p.merged : 0,
    invalid: Array.isArray(p.invalid)
      ? (p.invalid as { row: number; reason: string }[])
      : [],
    invalid_count: typeof p.invalid_count === "number" ? p.invalid_count : 0,
  };
}

export async function exportCustomersCsv(accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export type ConversationStatusResult =`;

const TARGETS = [
  {
    file: CONV_PATH,
    swaps: [
      { name: "p136-flask-imports", from: FLASK_IMPORT_FROM, to: FLASK_IMPORT_TO, guard: "def _normalize_pk_phone" },
      { name: "p136-auth-import", from: AUTH_IMPORT_FROM, to: AUTH_IMPORT_TO, guard: "ensure_human_principal" },
      { name: "p136-137-import-export", from: IMPORT_BLOCK_FROM, to: IMPORT_BLOCK_TO, guard: "customers/import" },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      { name: "p138-portal-lib", from: PORTAL_TS_FROM, to: PORTAL_TS_TO, guard: "importCustomers" },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/customers/page.tsx",
    swaps: [
      { name: "p139-component-import", from: PAGE_IMPORT_FROM, to: PAGE_IMPORT_TO, guard: 'from "./CustomersImport"' },
      { name: "p139-toolbar", from: PAGE_TOOLBAR_FROM, to: PAGE_TOOLBAR_TO, guard: "<CustomersImport" },
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

  const backup = target.file + ".pre_b136140.bak";
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