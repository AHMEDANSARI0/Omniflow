// add_export_selected.mjs - Phase 43: export only the selected conversations.
//
// GET /portal/conversations/export accepts ids=7,8,9 (cap 100, junk dropped)
// and combines it with the other export filters. The inbox bulk bar gets an
// Export selected button. Requires Phase 42 applied first. No new files, no
// restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_EXPORT_PATH = "Omniflow/app/api/omniflow/portal/conversations/export/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

// portal_conversations.py

const CP_PARSE_FROM = `    starred_filter = (request.args.get("starred") or "").strip()
    if starred_filter != "1":
        starred_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_PARSE_TO = `    starred_filter = (request.args.get("starred") or "").strip()
    if starred_filter != "1":
        starred_filter = ""
    raw_id_parts = (request.args.get("ids") or "").split(",")
    export_ids = []
    for part in raw_id_parts[:100]:
        part = part.strip()
        if part.isdigit():
            value = int(part)
            if value > 0 and value not in export_ids:
                export_ids.append(value)
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_WHERE_FROM = `    if starred_filter == "1":
        sql += " AND c.starred = TRUE"

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

const CP_WHERE_TO = `    if starred_filter == "1":
        sql += " AND c.starred = TRUE"
    if export_ids:
        sql += " AND c.id = ANY(%s)"
        params.append(export_ids)

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

// lib/omniflow/portal.ts

const LIB_IFACE_FROM = `export interface ConversationExportFilters {
  searchQuery?: string;`;

const LIB_IFACE_TO = `export interface ConversationExportFilters {
  ids?: number[];
  searchQuery?: string;`;

const LIB_PARTS_FROM = `  const parts: string[] = [];
  if (filters.searchQuery) {`;

const LIB_PARTS_TO = `  const parts: string[] = [];
  if (filters.ids && filters.ids.length) {
    parts.push("ids=" + filters.ids.slice(0, 100).join(","));
  }
  if (filters.searchQuery) {`;

// BFF export route

const BFF_PARSE_FROM = `  const rawSearch = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const searchQuery = rawSearch || undefined;`;

const BFF_PARSE_TO = `  const rawSearch = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const searchQuery = rawSearch || undefined;
  const rawIds = (url.searchParams.get("ids") || "").split(",");
  const ids: number[] = [];
  for (const part of rawIds.slice(0, 100)) {
    const value = Number(part.trim());
    if (part.trim() && Number.isInteger(value) && value > 0 && !ids.includes(value)) {
      ids.push(value);
    }
  }`;

const BFF_CALL_FROM = `    const data = await exportConversations(accessToken, {
      searchQuery,`;

const BFF_CALL_TO = `    const data = await exportConversations(accessToken, {
      ids: ids.length ? ids : undefined,
      searchQuery,`;

// inbox page

const PAGE_SIG_FROM = `  async function exportCsv() {
    if (exporting) return;`;

const PAGE_SIG_TO = `  async function exportCsv(selectedIds?: number[]) {
    if (exporting || (selectedIds && selectedIds.length === 0)) return;`;

const PAGE_PARAM_FROM = `      if (starredRef.current) params.set("starred", starredRef.current);
      const qs = params.toString();`;

const PAGE_PARAM_TO = `      if (starredRef.current) params.set("starred", starredRef.current);
      if (selectedIds) params.set("ids", selectedIds.join(","));
      const qs = params.toString();`;

const PAGE_NAME_FROM = `      link.download = "omniflow-conversations.csv";`;

const PAGE_NAME_TO = `      link.download = selectedIds
        ? "omniflow-conversations-selected.csv"
        : "omniflow-conversations.csv";`;

const PAGE_BUTTON_FROM = `          <span className="text-xs font-medium text-cyan-200">
            {selectedIds.length} selected
          </span>`;

const PAGE_BUTTON_TO = `          <span className="text-xs font-medium text-cyan-200">
            {selectedIds.length} selected
          </span>
          <button
            type="button"
            onClick={() => void exportCsv(selectedIds)}
            disabled={bulkBusy || exporting}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Export selected
          </button>`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-parse-ids", from: CP_PARSE_FROM, to: CP_PARSE_TO },
      { name: "cp-where-ids", from: CP_WHERE_FROM, to: CP_WHERE_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-iface", from: LIB_IFACE_FROM, to: LIB_IFACE_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
    ],
  },
  {
    file: BFF_EXPORT_PATH,
    swaps: [
      { name: "bff-parse-ids", from: BFF_PARSE_FROM, to: BFF_PARSE_TO },
      { name: "bff-call-ids", from: BFF_CALL_FROM, to: BFF_CALL_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-signature", from: PAGE_SIG_FROM, to: PAGE_SIG_TO },
      { name: "inbox-ids-param", from: PAGE_PARAM_FROM, to: PAGE_PARAM_TO },
      { name: "inbox-filename", from: PAGE_NAME_FROM, to: PAGE_NAME_TO },
      { name: "inbox-export-button", from: PAGE_BUTTON_FROM, to: PAGE_BUTTON_TO },
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

  const backup = target.file + ".pre_exsel.bak";
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