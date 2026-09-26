// add_assigned_filters.mjs - Phase 31: assigned filter for the inbox list and export.
//
// GET /portal/conversations and /portal/conversations/export accept
// assigned=unassigned or assigned=me (anything else keeps the full list).
// The inbox gets Unassigned and Mine chips next to the Oldest-first chip.
// Requires Phase 30 (add_inbox_sort.mjs) applied first. No restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

// portal_conversations.py

const CP_PARSE_LIST_FROM = `    sort_order = (request.args.get("sort") or "").strip().lower()
    if sort_order not in ("", "oldest"):
        sort_order = ""

    sql = (`;

const CP_PARSE_LIST_TO = `    sort_order = (request.args.get("sort") or "").strip().lower()
    if sort_order not in ("", "oldest"):
        sort_order = ""
    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""

    sql = (`;

const CP_PARSE_EXPORT_FROM = `    sort_order = (request.args.get("sort") or "").strip().lower()
    if sort_order not in ("", "oldest"):
        sort_order = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_PARSE_EXPORT_TO = `    sort_order = (request.args.get("sort") or "").strip().lower()
    if sort_order not in ("", "oldest"):
        sort_order = ""
    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_WHERE_LIST_FROM = `    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_LIST_TO = `    if assigned_filter == "unassigned":
        sql += " AND c.assigned_to IS NULL"
    elif assigned_filter == "me":
        sql += " AND c.assigned_to = %s"
        params.append(principal["email"])

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_EXPORT_FROM = `    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

const CP_WHERE_EXPORT_TO = `    if assigned_filter == "unassigned":
        sql += " AND c.assigned_to IS NULL"
    elif assigned_filter == "me":
        sql += " AND c.assigned_to = %s"
        params.append(principal["email"])

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

// lib/omniflow/portal.ts

const LIB_SIGNATURE_FROM = `  needsReplyFilter?: string,
  sortOrder?: string
): Promise<ConversationSummary[] | null> {`;

const LIB_SIGNATURE_TO = `  needsReplyFilter?: string,
  sortOrder?: string,
  assignedFilter?: string
): Promise<ConversationSummary[] | null> {`;

const LIB_PARTS_FROM = `  const sortPart = sortOrder === "oldest" ? "sort=oldest" : "";
  const parts = [
    searchPart,
    statusPart,
    intentPart,
    channelPart,
    tagPart,
    replyPart,
    sortPart,
  ].filter(Boolean);`;

const LIB_PARTS_TO = `  const sortPart = sortOrder === "oldest" ? "sort=oldest" : "";
  const assignedPart =
    assignedFilter === "unassigned" || assignedFilter === "me"
      ? "assigned=" + assignedFilter
      : "";
  const parts = [
    searchPart,
    statusPart,
    intentPart,
    channelPart,
    tagPart,
    replyPart,
    sortPart,
    assignedPart,
  ].filter(Boolean);`;

// BFF conversations route

const BFF_FROM = `    const sortRaw = url.searchParams.get("sort") || "";
    const sortOrder = sortRaw === "oldest" ? "oldest" : "";
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyFilter,
      sortOrder
    );
    if (conversations === null) {`;

const BFF_TO = `    const sortRaw = url.searchParams.get("sort") || "";
    const sortOrder = sortRaw === "oldest" ? "oldest" : "";
    const assignedRaw = url.searchParams.get("assigned") || "";
    const assignedFilter =
      assignedRaw === "unassigned" || assignedRaw === "me" ? assignedRaw : "";
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyFilter,
      sortOrder,
      assignedFilter
    );
    if (conversations === null) {`;

// inbox page

const PAGE_STATE_FROM = `  const [oldestFirst, setOldestFirst] = useState(false);
  const oldestRef = useRef(false);`;

const PAGE_STATE_TO = `  const [oldestFirst, setOldestFirst] = useState(false);
  const oldestRef = useRef(false);
  const [assignedFilter, setAssignedFilter] = useState("");
  const assignedRef = useRef("");`;

const PAGE_REFRESH_FROM = `      if (oldestRef.current) listParams.set("sort", "oldest");
      const listQs = listParams.toString();`;

const PAGE_REFRESH_TO = `      if (oldestRef.current) listParams.set("sort", "oldest");
      if (assignedRef.current) listParams.set("assigned", assignedRef.current);
      const listQs = listParams.toString();`;

const PAGE_EXPORT_FROM = `      if (oldestRef.current) params.set("sort", "oldest");
      const qs = params.toString();`;

const PAGE_EXPORT_TO = `      if (oldestRef.current) params.set("sort", "oldest");
      if (assignedRef.current) params.set("assigned", assignedRef.current);
      const qs = params.toString();`;

const PAGE_URL_SEED_FROM = `    if ((urlFilters.get("sort") || "") === "oldest") {
      oldestRef.current = true;
      setOldestFirst(true);
    }
    void refresh();`;

const PAGE_URL_SEED_TO = `    if ((urlFilters.get("sort") || "") === "oldest") {
      oldestRef.current = true;
      setOldestFirst(true);
    }
    const urlAssigned = urlFilters.get("assigned");
    if (urlAssigned === "unassigned" || urlAssigned === "me") {
      assignedRef.current = urlAssigned;
      setAssignedFilter(urlAssigned);
    }
    void refresh();`;

const PAGE_CHIPS_FROM = `          Oldest first
        </button>
      </div>`;

const PAGE_CHIPS_TO = `          Oldest first
        </button>
        <button
          type="button"
          onClick={() => {
            const next = assignedFilter === "unassigned" ? "" : "unassigned";
            assignedRef.current = next;
            setAssignedFilter(next);
            void refresh();
          }}
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
            assignedFilter === "unassigned"
              ? "border-sky-400/30 bg-sky-400/[0.08] text-sky-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }\`}
        >
          Unassigned
        </button>
        <button
          type="button"
          onClick={() => {
            const next = assignedFilter === "me" ? "" : "me";
            assignedRef.current = next;
            setAssignedFilter(next);
            void refresh();
          }}
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
            assignedFilter === "me"
              ? "border-indigo-400/30 bg-indigo-400/[0.08] text-indigo-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }\`}
        >
          Mine
        </button>
      </div>`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-parse-list", from: CP_PARSE_LIST_FROM, to: CP_PARSE_LIST_TO },
      { name: "cp-parse-export", from: CP_PARSE_EXPORT_FROM, to: CP_PARSE_EXPORT_TO },
      { name: "cp-where-list", from: CP_WHERE_LIST_FROM, to: CP_WHERE_LIST_TO },
      { name: "cp-where-export", from: CP_WHERE_EXPORT_FROM, to: CP_WHERE_EXPORT_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-signature", from: LIB_SIGNATURE_FROM, to: LIB_SIGNATURE_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-assigned-param", from: BFF_FROM, to: BFF_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-refresh-param", from: PAGE_REFRESH_FROM, to: PAGE_REFRESH_TO },
      { name: "inbox-export-param", from: PAGE_EXPORT_FROM, to: PAGE_EXPORT_TO },
      { name: "inbox-url-seed", from: PAGE_URL_SEED_FROM, to: PAGE_URL_SEED_TO },
      { name: "inbox-chips", from: PAGE_CHIPS_FROM, to: PAGE_CHIPS_TO },
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

  const backup = target.file + ".pre_asg.bak";
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