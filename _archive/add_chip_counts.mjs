// add_chip_counts.mjs - Phase 32: live counters on the inbox filter chips.
//
// GET /portal/conversations accepts include=counts and answers with a counts
// object (needs_reply, overdue, unassigned over all open conversations of the
// client). The BFF always asks for counts; the Needs reply, Overdue and
// Unassigned chips show their number once it is above zero. Requires Phase 31
// (add_assigned_filters.mjs) applied first. No restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";

// portal_conversations.py

const CP_INCLUDE_FROM = `    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""

    sql = (`;

const CP_INCLUDE_TO = `    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    include_counts = (request.args.get("include") or "").strip().lower() == "counts"

    sql = (`;

const CP_COUNTS_FROM = `    conversations = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        conversations.append(item)
    return jsonify({"conversations": conversations}), 200`;

const CP_COUNTS_TO = `    conversations = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        conversations.append(item)

    counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0}
    if include_counts:
        counts_sql = (
            "SELECT COUNT(*) FILTER (WHERE EXISTS ("
            " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0)"
            " )) AS needs_reply,"
            " COUNT(*) FILTER (WHERE EXISTS ("
            " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " od WHERE od.conversation_id = c.id"
            " GROUP BY od.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN od.direction = 'in' THEN od.id END), 0)"
            " > COALESCE(MAX(CASE WHEN od.direction = 'out' THEN od.id END), 0)"
            " AND MAX(CASE WHEN od.direction = 'in' THEN od.created_at END)"
            " < NOW() - make_interval(hours => %s)"
            " )) AS overdue,"
            " COUNT(*) FILTER (WHERE c.assigned_to IS NULL) AS unassigned"
            " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
            " WHERE c.client_id = %s AND c.status = 'open'"
        )
        try:
            portal_db.ensure_tables()
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    cur.execute(counts_sql, (OVERDUE_HOURS, principal["client_id"]))
                    summary = portal_db.rows(cur)
                    if summary:
                        counts = {
                            "needs_reply": int(summary[0].get("needs_reply") or 0),
                            "overdue": int(summary[0].get("overdue") or 0),
                            "unassigned": int(summary[0].get("unassigned") or 0),
                        }
            finally:
                conn.close()
        except Exception:
            counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0}

    response_payload = {"conversations": conversations}
    if include_counts:
        response_payload["counts"] = counts
    return jsonify(response_payload), 200`;

// lib/omniflow/portal.ts

const LIB_TYPE_FROM = `export interface ConversationSummary {`;

const LIB_TYPE_TO = `export type ConversationChipCounts = {
  needsReply: number;
  overdue: number;
  unassigned: number;
};

export interface ConversationSummary {`;

const LIB_SIGNATURE_FROM = `  sortOrder?: string,
  assignedFilter?: string
): Promise<ConversationSummary[] | null> {`;

const LIB_SIGNATURE_TO = `  sortOrder?: string,
  assignedFilter?: string,
  includeCounts?: boolean
): Promise<
  { conversations: ConversationSummary[]; counts: ConversationChipCounts | null } | null
> {`;

const LIB_PARTS_FROM = `  const assignedPart =
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

const LIB_PARTS_TO = `  const assignedPart =
    assignedFilter === "unassigned" || assignedFilter === "me"
      ? "assigned=" + assignedFilter
      : "";
  const countsPart = includeCounts ? "include=counts" : "";
  const parts = [
    searchPart,
    statusPart,
    intentPart,
    channelPart,
    tagPart,
    replyPart,
    sortPart,
    assignedPart,
    countsPart,
  ].filter(Boolean);`;

const LIB_TAIL_FROM = `  return conversations;
}

export type ConversationDetailResult =`;

const LIB_TAIL_TO = `  const rawCounts = (payload as Record<string, unknown>).counts;
  let counts: ConversationChipCounts | null = null;
  if (rawCounts && typeof rawCounts === "object") {
    const record = rawCounts as Record<string, unknown>;
    counts = {
      needsReply: Number(record.needs_reply) || 0,
      overdue: Number(record.overdue) || 0,
      unassigned: Number(record.unassigned) || 0,
    };
  }
  return { conversations, counts };
}

export type ConversationDetailResult =`;

// BFF conversations route

const BFF_CALL_FROM = `    const conversations = await listConversations(
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

const BFF_CALL_TO = `    const result = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyFilter,
      sortOrder,
      assignedFilter,
      true
    );
    if (result === null) {`;

const BFF_RESPONSE_FROM = `    return safeJson({ conversations }, 200);`;

const BFF_RESPONSE_TO = `    return safeJson(
      { conversations: result.conversations, counts: result.counts },
      200
    );`;

// inbox page

const PAGE_STATE_FROM = `  const [assignedFilter, setAssignedFilter] = useState("");
  const assignedRef = useRef("");`;

const PAGE_STATE_TO = `  const [assignedFilter, setAssignedFilter] = useState("");
  const assignedRef = useRef("");
  const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
  });`;

const PAGE_PAYLOAD_FROM = `      const payload = (await response.json().catch(() => null)) as {
        conversations?: ConversationSummary[];
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.conversations)) {
        setItems(payload.conversations);
        setPending(false);
      } else if (payload.error?.code === "portal_pending") {`;

const PAGE_PAYLOAD_TO = `      const payload = (await response.json().catch(() => null)) as {
        conversations?: ConversationSummary[];
        counts?: { needsReply?: number; overdue?: number; unassigned?: number };
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.conversations)) {
        setItems(payload.conversations);
        setPending(false);
        if (payload.counts) {
          setChipCounts({
            needsReply: payload.counts.needsReply || 0,
            overdue: payload.counts.overdue || 0,
            unassigned: payload.counts.unassigned || 0,
          });
        }
      } else if (payload.error?.code === "portal_pending") {`;

const PAGE_CHIP_REPLY_FROM = `          Needs reply
        </button>`;

const PAGE_CHIP_REPLY_TO = `          Needs reply
          {chipCounts.needsReply > 0 && (
            <span className="ml-1.5 rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
              {chipCounts.needsReply}
            </span>
          )}
        </button>`;

const PAGE_CHIP_OVERDUE_FROM = `          Overdue
        </button>`;

const PAGE_CHIP_OVERDUE_TO = `          Overdue
          {chipCounts.overdue > 0 && (
            <span className="ml-1.5 rounded-md bg-red-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
              {chipCounts.overdue}
            </span>
          )}
        </button>`;

const PAGE_CHIP_UNASSIGNED_FROM = `          Unassigned
        </button>`;

const PAGE_CHIP_UNASSIGNED_TO = `          Unassigned
          {chipCounts.unassigned > 0 && (
            <span className="ml-1.5 rounded-md bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
              {chipCounts.unassigned}
            </span>
          )}
        </button>`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-include", from: CP_INCLUDE_FROM, to: CP_INCLUDE_TO },
      { name: "cp-counts", from: CP_COUNTS_FROM, to: CP_COUNTS_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-type", from: LIB_TYPE_FROM, to: LIB_TYPE_TO },
      { name: "lib-signature", from: LIB_SIGNATURE_FROM, to: LIB_SIGNATURE_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
      { name: "lib-tail", from: LIB_TAIL_FROM, to: LIB_TAIL_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-call", from: BFF_CALL_FROM, to: BFF_CALL_TO },
      { name: "bff-response", from: BFF_RESPONSE_FROM, to: BFF_RESPONSE_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-payload", from: PAGE_PAYLOAD_FROM, to: PAGE_PAYLOAD_TO },
      { name: "inbox-chip-reply", from: PAGE_CHIP_REPLY_FROM, to: PAGE_CHIP_REPLY_TO },
      { name: "inbox-chip-overdue", from: PAGE_CHIP_OVERDUE_FROM, to: PAGE_CHIP_OVERDUE_TO },
      { name: "inbox-chip-unassigned", from: PAGE_CHIP_UNASSIGNED_FROM, to: PAGE_CHIP_UNASSIGNED_TO },
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

  const backup = target.file + ".pre_counts.bak";
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