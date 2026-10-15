// add_unread_filter.mjs - Phase 37: unread filter chip for the inbox.
//
// GET /portal/conversations and /portal/conversations/export accept unread=1
// (conversations with at least one inbound message newer than last_read_at).
// The inbox gets a violet Unread chip next to the Any time select. Requires
// Phase 36 applied first. No new files, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

// portal_conversations.py

const CP_PARSE_LIST_FROM = `    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    include_counts = (request.args.get("include") or "").strip().lower() == "counts"`;

const CP_PARSE_LIST_TO = `    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    unread_filter = (request.args.get("unread") or "").strip()
    if unread_filter != "1":
        unread_filter = ""
    include_counts = (request.args.get("include") or "").strip().lower() == "counts"`;

const CP_PARSE_EXPORT_FROM = `    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_PARSE_EXPORT_TO = `    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    unread_filter = (request.args.get("unread") or "").strip()
    if unread_filter != "1":
        unread_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_WHERE_LIST_FROM = `    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_LIST_TO = `    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))
    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_EXPORT_FROM = `    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

const CP_WHERE_EXPORT_TO = `    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))
    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

// lib/omniflow/portal.ts

const LIB_SIGNATURE_FROM = `  limit?: number,
  daysFilter?: string
): Promise<`;

const LIB_SIGNATURE_TO = `  limit?: number,
  daysFilter?: string,
  unreadFilter?: string
): Promise<`;

const LIB_PART_FROM = `  const daysPart = daysFilter ? "days=" + encodeURIComponent(daysFilter) : "";`;

const LIB_PART_TO = `  const daysPart = daysFilter ? "days=" + encodeURIComponent(daysFilter) : "";
  const unreadPart = unreadFilter === "1" ? "unread=1" : "";`;

const LIB_PARTS_FROM = `    limitPart,
    daysPart,
  ].filter(Boolean);`;

const LIB_PARTS_TO = `    limitPart,
    daysPart,
    unreadPart,
  ].filter(Boolean);`;

// BFF conversations route

const BFF_PARSE_FROM = `    const daysRaw = url.searchParams.get("days") || "";
    const daysFilter = daysRaw === "1" || daysRaw === "7" || daysRaw === "30" ? daysRaw : "";`;

const BFF_PARSE_TO = `    const daysRaw = url.searchParams.get("days") || "";
    const daysFilter = daysRaw === "1" || daysRaw === "7" || daysRaw === "30" ? daysRaw : "";
    const unreadFilter = url.searchParams.get("unread") === "1" ? "1" : "";`;

const BFF_CALL_FROM = `      limitFilter,
      daysFilter
    );`;

const BFF_CALL_TO = `      limitFilter,
      daysFilter,
      unreadFilter
    );`;

// inbox page

const PAGE_STATE_FROM = `  const [daysFilter, setDaysFilter] = useState("");
  const daysRef = useRef("");`;

const PAGE_STATE_TO = `  const [daysFilter, setDaysFilter] = useState("");
  const daysRef = useRef("");
  const [unreadFilter, setUnreadFilter] = useState("");
  const unreadRef = useRef("");`;

const PAGE_REFRESH_FROM = `      if (daysRef.current) listParams.set("days", daysRef.current);
      const listQs = listParams.toString();`;

const PAGE_REFRESH_TO = `      if (daysRef.current) listParams.set("days", daysRef.current);
      if (unreadRef.current) listParams.set("unread", unreadRef.current);
      const listQs = listParams.toString();`;

const PAGE_EXPORT_FROM = `      if (daysRef.current) params.set("days", daysRef.current);
      const qs = params.toString();`;

const PAGE_EXPORT_TO = `      if (daysRef.current) params.set("days", daysRef.current);
      if (unreadRef.current) params.set("unread", unreadRef.current);
      const qs = params.toString();`;

const PAGE_SEED_FROM = `    const urlDays = urlFilters.get("days");
    if (urlDays === "1" || urlDays === "7" || urlDays === "30") {
      daysRef.current = urlDays;
      setDaysFilter(urlDays);
    }
    void refresh();`;

const PAGE_SEED_TO = `    const urlDays = urlFilters.get("days");
    if (urlDays === "1" || urlDays === "7" || urlDays === "30") {
      daysRef.current = urlDays;
      setDaysFilter(urlDays);
    }
    if (urlFilters.get("unread") === "1") {
      unreadRef.current = "1";
      setUnreadFilter("1");
    }
    void refresh();`;

const PAGE_CHIP_FROM = `          <option value="30">Last 30 days</option>
        </select>
      </div>`;

const PAGE_CHIP_TO = `          <option value="30">Last 30 days</option>
        </select>
        <button
          type="button"
          onClick={() => {
            const next = unreadFilter === "1" ? "" : "1";
            unreadRef.current = next;
            setUnreadFilter(next);
            void refresh();
          }}
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
            unreadFilter === "1"
              ? "border-violet-400/30 bg-violet-400/[0.08] text-violet-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }\`}
        >
          Unread
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
      { name: "lib-unread-part", from: LIB_PART_FROM, to: LIB_PART_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-unread-parse", from: BFF_PARSE_FROM, to: BFF_PARSE_TO },
      { name: "bff-unread-call", from: BFF_CALL_FROM, to: BFF_CALL_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-refresh-param", from: PAGE_REFRESH_FROM, to: PAGE_REFRESH_TO },
      { name: "inbox-export-param", from: PAGE_EXPORT_FROM, to: PAGE_EXPORT_TO },
      { name: "inbox-url-seed", from: PAGE_SEED_FROM, to: PAGE_SEED_TO },
      { name: "inbox-chip", from: PAGE_CHIP_FROM, to: PAGE_CHIP_TO },
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

  const backup = target.file + ".pre_unread.bak";
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