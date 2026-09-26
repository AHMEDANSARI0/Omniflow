// add_date_filter.mjs - Phase 36: activity-window filter for the inbox.
//
// GET /portal/conversations and /portal/conversations/export accept
// days=1|7|30 (only recent activity; anything else keeps the full history).
// The inbox gets an Any time select next to the Mine chip. Requires Phase 35
// applied first. No new files, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

// portal_conversations.py

const CP_PARSE_LIST_FROM = `    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    include_counts = (request.args.get("include") or "").strip().lower() == "counts"`;

const CP_PARSE_LIST_TO = `    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    include_counts = (request.args.get("include") or "").strip().lower() == "counts"`;

const CP_PARSE_EXPORT_FROM = `    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_PARSE_EXPORT_TO = `    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_WHERE_LIST_FROM = `        params.append(principal["email"])

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_LIST_TO = `        params.append(principal["email"])

    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_EXPORT_FROM = `        params.append(principal["email"])

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

const CP_WHERE_EXPORT_TO = `        params.append(principal["email"])

    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

// lib/omniflow/portal.ts

const LIB_SIGNATURE_FROM = `  includeCounts?: boolean,
  limit?: number
): Promise<`;

const LIB_SIGNATURE_TO = `  includeCounts?: boolean,
  limit?: number,
  daysFilter?: string
): Promise<`;

const LIB_PART_FROM = `  const limitPart =
    limit && limit >= 1 && limit <= 50 ? "limit=" + Math.floor(limit) : "";`;

const LIB_PART_TO = `  const limitPart =
    limit && limit >= 1 && limit <= 50 ? "limit=" + Math.floor(limit) : "";
  const daysPart = daysFilter ? "days=" + encodeURIComponent(daysFilter) : "";`;

const LIB_PARTS_FROM = `    countsPart,
    limitPart,
  ].filter(Boolean);`;

const LIB_PARTS_TO = `    countsPart,
    limitPart,
    daysPart,
  ].filter(Boolean);`;

// BFF conversations route

const BFF_PARSE_FROM = `    const limitRaw = url.searchParams.get("limit") || "";
    const limitNumber = Number(limitRaw);
    const limitFilter =
      limitRaw && Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= 50
        ? limitNumber
        : undefined;`;

const BFF_PARSE_TO = `    const limitRaw = url.searchParams.get("limit") || "";
    const limitNumber = Number(limitRaw);
    const limitFilter =
      limitRaw && Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= 50
        ? limitNumber
        : undefined;
    const daysRaw = url.searchParams.get("days") || "";
    const daysFilter = daysRaw === "1" || daysRaw === "7" || daysRaw === "30" ? daysRaw : "";`;

const BFF_CALL_FROM = `      true,
      limitFilter
    );`;

const BFF_CALL_TO = `      true,
      limitFilter,
      daysFilter
    );`;

// inbox page

const PAGE_STATE_FROM = `  const [assignedFilter, setAssignedFilter] = useState("");
  const assignedRef = useRef("");`;

const PAGE_STATE_TO = `  const [assignedFilter, setAssignedFilter] = useState("");
  const assignedRef = useRef("");
  const [daysFilter, setDaysFilter] = useState("");
  const daysRef = useRef("");`;

const PAGE_REFRESH_FROM = `      if (assignedRef.current) listParams.set("assigned", assignedRef.current);
      const listQs = listParams.toString();`;

const PAGE_REFRESH_TO = `      if (assignedRef.current) listParams.set("assigned", assignedRef.current);
      if (daysRef.current) listParams.set("days", daysRef.current);
      const listQs = listParams.toString();`;

const PAGE_EXPORT_FROM = `      if (assignedRef.current) params.set("assigned", assignedRef.current);
      const qs = params.toString();`;

const PAGE_EXPORT_TO = `      if (assignedRef.current) params.set("assigned", assignedRef.current);
      if (daysRef.current) params.set("days", daysRef.current);
      const qs = params.toString();`;

const PAGE_SEED_FROM = `    const urlAssigned = urlFilters.get("assigned");
    if (urlAssigned === "unassigned" || urlAssigned === "me") {
      assignedRef.current = urlAssigned;
      setAssignedFilter(urlAssigned);
    }
    void refresh();`;

const PAGE_SEED_TO = `    const urlAssigned = urlFilters.get("assigned");
    if (urlAssigned === "unassigned" || urlAssigned === "me") {
      assignedRef.current = urlAssigned;
      setAssignedFilter(urlAssigned);
    }
    const urlDays = urlFilters.get("days");
    if (urlDays === "1" || urlDays === "7" || urlDays === "30") {
      daysRef.current = urlDays;
      setDaysFilter(urlDays);
    }
    void refresh();`;

const PAGE_SELECT_FROM = `          Mine
        </button>
      </div>`;

const PAGE_SELECT_TO = `          Mine
        </button>
        <select
          value={daysFilter}
          onChange={(event) => {
            daysRef.current = event.target.value;
            setDaysFilter(event.target.value);
            void refresh();
          }}
          className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-xs font-medium text-slate-300 outline-none transition-colors focus:border-cyan-400/40"
        >
          <option value="">Any time</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
        </select>
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
      { name: "lib-days-part", from: LIB_PART_FROM, to: LIB_PART_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-days-parse", from: BFF_PARSE_FROM, to: BFF_PARSE_TO },
      { name: "bff-days-call", from: BFF_CALL_FROM, to: BFF_CALL_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-refresh-param", from: PAGE_REFRESH_FROM, to: PAGE_REFRESH_TO },
      { name: "inbox-export-param", from: PAGE_EXPORT_FROM, to: PAGE_EXPORT_TO },
      { name: "inbox-url-seed", from: PAGE_SEED_FROM, to: PAGE_SEED_TO },
      { name: "inbox-select", from: PAGE_SELECT_FROM, to: PAGE_SELECT_TO },
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

  const backup = target.file + ".pre_days.bak";
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