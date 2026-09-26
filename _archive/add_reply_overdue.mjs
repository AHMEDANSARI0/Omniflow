// add_reply_overdue.mjs - Phase 28: overdue reply alerts (SLA).
//
// Extends the needs-reply feature with timing: when a customer has been
// waiting longer than OF_SLA_HOURS (default 4), the chat counts as overdue.
// Overview shows a red banner and an overdue count, the inbox gets an
// Overdue chip, and /dashboard/conversations now honours ?q= and
// ?needs_reply= on load (this also fixes the customer-to-inbox deep link).
// No bridge changes, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const CP_GROWTH_PATH = "OmniFlow-Control-Plane/portal_growth.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const OVERVIEW_PAGE_PATH = "Omniflow/app/dashboard/(portal)/page.tsx";

// portal_conversations.py

const CONV_OS_FROM = `import json
import logging`;

const CONV_OS_TO = `import json
import logging
import os`;

const CONV_CONST_FROM = `WELCOME_SETTINGS_TABLE = portal_db.AUTOMATION_SETTINGS_TABLE`;

const CONV_CONST_TO = `WELCOME_SETTINGS_TABLE = portal_db.AUTOMATION_SETTINGS_TABLE

try:
    OVERDUE_HOURS = max(1, min(72, int(os.environ.get("OF_SLA_HOURS", "4"))))
except ValueError:
    OVERDUE_HOURS = 4`;

const CONV_LIST_FILTER_FROM = `    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0))"
        )`;

const CONV_LIST_FILTER_TO = `    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0)"
        )
        if needs_reply_filter == "overdue":
            sql += (
                " AND MAX(CASE WHEN nr.direction = 'in' THEN nr.created_at END)"
                " < NOW() - make_interval(hours => %s)"
            )
            params.append(OVERDUE_HOURS)
        sql += ")"`;

const CONV_EXPORT_FILTER_FROM = `    if (request.args.get("needs_reply") or "").strip() == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0))"
        )`;

const CONV_EXPORT_FILTER_TO = `    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter
    if export_reply in ("1", "overdue"):
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0)"
        )
        if export_reply == "overdue":
            sql += (
                " AND MAX(CASE WHEN nr.direction = 'in' THEN nr.created_at END)"
                " < NOW() - make_interval(hours => %s)"
            )
            params.append(OVERDUE_HOURS)
        sql += ")"`;

// portal_growth.py

const GROWTH_OS_FROM = `import logging
import re`;

const GROWTH_OS_TO = `import logging
import os
import re`;

const GROWTH_CONST_FROM = `CSAT_WINDOW_HOURS = 48`;

const GROWTH_CONST_TO = `CSAT_WINDOW_HOURS = 48

try:
    OVERDUE_HOURS = max(1, min(72, int(os.environ.get("OF_SLA_HOURS", "4"))))
except ValueError:
    OVERDUE_HOURS = 4`;

const GROWTH_QUERY_FROM = `                    " ) AS needs_reply_open",
                    (client_id, client_id, client_id, client_id, client_id, client_id),`;

const GROWTH_QUERY_TO = `                    " ) AS needs_reply_open,"
                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " od WHERE od.client_id = %s AND od.status = 'open'"
                    " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
                    " om WHERE om.conversation_id = od.id"
                    " GROUP BY om.conversation_id"
                    " HAVING COALESCE(MAX(CASE WHEN om.direction = 'in' THEN om.id END), 0)"
                    " > COALESCE(MAX(CASE WHEN om.direction = 'out' THEN om.id END), 0)"
                    " AND MAX(CASE WHEN om.direction = 'in' THEN om.created_at END)"
                    " < NOW() - make_interval(hours => %s))"
                    " ) AS needs_reply_overdue",
                    (client_id, client_id, client_id, client_id, client_id, client_id,
                     client_id, OVERDUE_HOURS),`;

const GROWTH_RESPONSE_FROM = `            "needs_reply_open": int(stats.get("needs_reply_open") or 0),`;

const GROWTH_RESPONSE_TO = `            "needs_reply_open": int(stats.get("needs_reply_open") or 0),
            "needs_reply_overdue": int(stats.get("needs_reply_overdue") or 0),`;

// lib/omniflow/portal.ts

const LIB_IFACE_FROM = `  openNow: number;
  unassignedOpen: number;
  needsReplyOpen: number;
  hotLeads: OverviewHotLead[];`;

const LIB_IFACE_TO = `  openNow: number;
  unassignedOpen: number;
  needsReplyOpen: number;
  needsReplyOverdue: number;
  hotLeads: OverviewHotLead[];`;

const LIB_MAP_FROM = `    needsReplyOpen:
      typeof stats.needs_reply_open === "number" ? stats.needs_reply_open : 0,
    hotLeads,`;

const LIB_MAP_TO = `    needsReplyOpen:
      typeof stats.needs_reply_open === "number" ? stats.needs_reply_open : 0,
    needsReplyOverdue:
      typeof stats.needs_reply_overdue === "number" ? stats.needs_reply_overdue : 0,
    hotLeads,`;

const LIB_SIGNATURE_FROM = `  needsReplyOnly?: boolean
): Promise<ConversationSummary[] | null> {`;

const LIB_SIGNATURE_TO = `  needsReplyFilter?: string
): Promise<ConversationSummary[] | null> {`;

const LIB_PARTS_FROM = `  const replyPart = needsReplyOnly ? "needs_reply=1" : "";`;

const LIB_PARTS_TO = `  const replyPart =
    needsReplyFilter === "1" || needsReplyFilter === "overdue"
      ? "needs_reply=" + needsReplyFilter
      : "";`;

// BFF conversations route

const BFF_FROM = `    const needsReplyOnly = url.searchParams.get("needs_reply") === "1";
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyOnly
    );`;

const BFF_TO = `    const needsReplyRaw = url.searchParams.get("needs_reply") || "";
    const needsReplyFilter =
      needsReplyRaw === "1" || needsReplyRaw === "overdue" ? needsReplyRaw : "";
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyFilter
    );`;

// Inbox page

const PAGE_STATE_FROM = `  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const needsReplyRef = useRef(false);`;

const PAGE_STATE_TO = `  const [replyFilter, setReplyFilter] = useState("");
  const replyFilterRef = useRef("");`;

const PAGE_REFRESH_FROM = `      if (needsReplyRef.current) listParams.set("needs_reply", "1");`;

const PAGE_REFRESH_TO = `      if (replyFilterRef.current) listParams.set("needs_reply", replyFilterRef.current);`;

const PAGE_EXPORT_FROM = `      if (tagRef.current !== "all") params.set("tag", tagRef.current);
      const qs = params.toString();`;

const PAGE_EXPORT_TO = `      if (tagRef.current !== "all") params.set("tag", tagRef.current);
      if (replyFilterRef.current) params.set("needs_reply", replyFilterRef.current);
      const qs = params.toString();`;

const PAGE_MOUNT_FROM = `  useEffect(() => {
    mounted.current = true;
    void refresh();`;

const PAGE_MOUNT_TO = `  useEffect(() => {
    mounted.current = true;
    const urlFilters = new URLSearchParams(window.location.search);
    const urlQuery = (urlFilters.get("q") || "").trim();
    if (urlQuery) {
      searchRef.current = urlQuery;
      setSearch(urlQuery);
    }
    const urlReply = urlFilters.get("needs_reply");
    if (urlReply === "1" || urlReply === "overdue") {
      replyFilterRef.current = urlReply;
      setReplyFilter(urlReply);
    }
    void refresh();`;

const PAGE_CHIP_FROM = `        <button
          type="button"
          onClick={() => {
            const next = !needsReplyRef.current;
            needsReplyRef.current = next;
            setNeedsReplyOnly(next);
            void refresh();
          }}
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
            needsReplyOnly
              ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }\`}
        >
          Needs reply
        </button>`;

const PAGE_CHIP_TO = `        <button
          type="button"
          onClick={() => {
            const next = replyFilter === "1" ? "" : "1";
            replyFilterRef.current = next;
            setReplyFilter(next);
            void refresh();
          }}
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
            replyFilter === "1"
              ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }\`}
        >
          Needs reply
        </button>
        <button
          type="button"
          onClick={() => {
            const next = replyFilter === "overdue" ? "" : "overdue";
            replyFilterRef.current = next;
            setReplyFilter(next);
            void refresh();
          }}
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
            replyFilter === "overdue"
              ? "border-red-400/30 bg-red-400/[0.08] text-red-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }\`}
        >
          Overdue
        </button>`;

// Overview page

const OVERVIEW_TILE_FROM = `            <StatTile
              label="Needs reply"
              value={overview.needsReplyOpen}
              sub="customer sent the last message"
            />`;

const OVERVIEW_TILE_TO = `            <StatTile
              label="Needs reply"
              value={overview.needsReplyOpen}
              sub={
                overview.needsReplyOverdue > 0
                  ? overview.needsReplyOverdue + " overdue"
                  : "customer sent the last message"
              }
            />`;

const OVERVIEW_BANNER_FROM = `          {overview.unassignedOpen > 0 && (`;

const OVERVIEW_BANNER_TO = `          {overview.needsReplyOverdue > 0 && (
            <Link
              href="/dashboard/conversations?needs_reply=overdue"
              className="mb-6 flex items-center justify-between gap-3 rounded-2xl border border-red-400/25 bg-red-400/[0.06] px-5 py-4 transition-colors duration-300 hover:bg-red-400/[0.10]"
            >
              <span className="text-sm text-red-200">
                {overview.needsReplyOverdue}{" "}
                {overview.needsReplyOverdue === 1 ? "customer is" : "customers are"} waiting longer than the reply SLA.
              </span>
              <span className="shrink-0 text-xs font-medium text-red-300">
                Review overdue →
              </span>
            </Link>
          )}
          {overview.unassignedOpen > 0 && (`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "conv-os-import", from: CONV_OS_FROM, to: CONV_OS_TO },
      { name: "conv-sla-const", from: CONV_CONST_FROM, to: CONV_CONST_TO },
      { name: "conv-list-filter", from: CONV_LIST_FILTER_FROM, to: CONV_LIST_FILTER_TO },
      { name: "conv-export-filter", from: CONV_EXPORT_FILTER_FROM, to: CONV_EXPORT_FILTER_TO },
    ],
  },
  {
    file: CP_GROWTH_PATH,
    swaps: [
      { name: "growth-os-import", from: GROWTH_OS_FROM, to: GROWTH_OS_TO },
      { name: "growth-sla-const", from: GROWTH_CONST_FROM, to: GROWTH_CONST_TO },
      { name: "growth-overdue-counter", from: GROWTH_QUERY_FROM, to: GROWTH_QUERY_TO },
      { name: "growth-response-key", from: GROWTH_RESPONSE_FROM, to: GROWTH_RESPONSE_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-overview-interface", from: LIB_IFACE_FROM, to: LIB_IFACE_TO },
      { name: "lib-overview-mapping", from: LIB_MAP_FROM, to: LIB_MAP_TO },
      { name: "lib-list-signature", from: LIB_SIGNATURE_FROM, to: LIB_SIGNATURE_TO },
      { name: "lib-list-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-filter-values", from: BFF_FROM, to: BFF_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-refresh-param", from: PAGE_REFRESH_FROM, to: PAGE_REFRESH_TO },
      { name: "inbox-export-param", from: PAGE_EXPORT_FROM, to: PAGE_EXPORT_TO },
      { name: "inbox-url-seed", from: PAGE_MOUNT_FROM, to: PAGE_MOUNT_TO },
      { name: "inbox-chips", from: PAGE_CHIP_FROM, to: PAGE_CHIP_TO },
    ],
  },
  {
    file: OVERVIEW_PAGE_PATH,
    swaps: [
      { name: "overview-tile-sub", from: OVERVIEW_TILE_FROM, to: OVERVIEW_TILE_TO },
      { name: "overview-red-banner", from: OVERVIEW_BANNER_FROM, to: OVERVIEW_BANNER_TO },
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

  const backup = target.file + ".pre_odue.bak";
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