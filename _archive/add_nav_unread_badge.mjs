// add_nav_unread_badge.mjs - Phase 35: server-computed unread badge + counts upgrade.
//
// The include=counts aggregate gains an unread column (messages newer than
// last_read_at over open conversations), listConversations accepts a limit so
// the sidebar can poll a one-row page, and DashSidebar switches from counting
// unread client-side over the full list to reading counts.unread. Requires
// Phase 34 applied first. No new files, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const SIDEBAR_PATH = "Omniflow/app/dashboard/components/DashSidebar.tsx";

// portal_conversations.py

const CP_COUNTS_SELECT_FROM = `            " COUNT(*) FILTER (WHERE c.assigned_to IS NULL) AS unassigned"`;

const CP_COUNTS_SELECT_TO = `            " COUNT(*) FILTER (WHERE EXISTS ("
            " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))"
            " )) AS unread,"
            " COUNT(*) FILTER (WHERE c.assigned_to IS NULL) AS unassigned"`;

const CP_COUNTS_INIT_FROM = `    counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0}
    if include_counts:`;

const CP_COUNTS_INIT_TO = `    counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0, "unread": 0}
    if include_counts:`;

const CP_COUNTS_EXCEPT_FROM = `        except Exception:
            counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0}`;

const CP_COUNTS_EXCEPT_TO = `        except Exception:
            counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0, "unread": 0}`;

const CP_COUNTS_PARSE_FROM = `                            "unassigned": int(summary[0].get("unassigned") or 0),
                        }`;

const CP_COUNTS_PARSE_TO = `                            "unassigned": int(summary[0].get("unassigned") or 0),
                            "unread": int(summary[0].get("unread") or 0),
                        }`;

// lib/omniflow/portal.ts

const LIB_TYPE_FROM = `export type ConversationChipCounts = {
  needsReply: number;
  overdue: number;
  unassigned: number;
};`;

const LIB_TYPE_TO = `export type ConversationChipCounts = {
  needsReply: number;
  overdue: number;
  unassigned: number;
  unread: number;
};`;

const LIB_PARSE_FROM = `      unassigned: Number(record.unassigned) || 0,
    };`;

const LIB_PARSE_TO = `      unassigned: Number(record.unassigned) || 0,
      unread: Number(record.unread) || 0,
    };`;

const LIB_SIGNATURE_FROM = `  assignedFilter?: string,
  includeCounts?: boolean
): Promise<`;

const LIB_SIGNATURE_TO = `  assignedFilter?: string,
  includeCounts?: boolean,
  limit?: number
): Promise<`;

const LIB_LIMIT_PART_FROM = `  const countsPart = includeCounts ? "include=counts" : "";`;

const LIB_LIMIT_PART_TO = `  const countsPart = includeCounts ? "include=counts" : "";
  const limitPart =
    limit && limit >= 1 && limit <= 50 ? "limit=" + Math.floor(limit) : "";`;

const LIB_PARTS_FROM = `    countsPart,
  ].filter(Boolean);`;

const LIB_PARTS_TO = `    countsPart,
    limitPart,
  ].filter(Boolean);`;

// BFF conversations route

const BFF_PARSE_FROM = `    const assignedRaw = url.searchParams.get("assigned") || "";
    const assignedFilter =
      assignedRaw === "unassigned" || assignedRaw === "me" ? assignedRaw : "";`;

const BFF_PARSE_TO = `    const assignedRaw = url.searchParams.get("assigned") || "";
    const assignedFilter =
      assignedRaw === "unassigned" || assignedRaw === "me" ? assignedRaw : "";
    const limitRaw = url.searchParams.get("limit") || "";
    const limitNumber = Number(limitRaw);
    const limitFilter =
      limitRaw && Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= 50
        ? limitNumber
        : undefined;`;

const BFF_CALL_FROM = `      assignedFilter,
      true
    );`;

const BFF_CALL_TO = `      assignedFilter,
      true,
      limitFilter
    );`;

// DashSidebar

const SIDEBAR_FETCH_FROM = `        const response = await fetch("/api/omniflow/portal/conversations", {
          credentials: "same-origin",
          cache: "no-store",
        });`;

const SIDEBAR_FETCH_TO = `        const response = await fetch(
          "/api/omniflow/portal/conversations?include=counts&limit=1",
          {
            credentials: "same-origin",
            cache: "no-store",
          }
        );`;

const SIDEBAR_PAYLOAD_FROM = `        const payload = (await response.json().catch(() => null)) as {
          conversations?: { unread?: boolean }[];
        } | null;
        if (
          alive &&
          payload &&
          Array.isArray(payload.conversations)
        ) {
          setUnreadCount(
            payload.conversations.filter(
              (conversation) => conversation.unread === true
            ).length
          );
        }`;

const SIDEBAR_PAYLOAD_TO = `        const payload = (await response.json().catch(() => null)) as {
          counts?: { unread?: number };
        } | null;
        if (alive && payload) {
          setUnreadCount(payload.counts?.unread || 0);
        }`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-counts-select", from: CP_COUNTS_SELECT_FROM, to: CP_COUNTS_SELECT_TO },
      { name: "cp-counts-init", from: CP_COUNTS_INIT_FROM, to: CP_COUNTS_INIT_TO },
      { name: "cp-counts-except", from: CP_COUNTS_EXCEPT_FROM, to: CP_COUNTS_EXCEPT_TO },
      { name: "cp-counts-parse", from: CP_COUNTS_PARSE_FROM, to: CP_COUNTS_PARSE_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-type", from: LIB_TYPE_FROM, to: LIB_TYPE_TO },
      { name: "lib-parse", from: LIB_PARSE_FROM, to: LIB_PARSE_TO },
      { name: "lib-signature", from: LIB_SIGNATURE_FROM, to: LIB_SIGNATURE_TO },
      { name: "lib-limit-part", from: LIB_LIMIT_PART_FROM, to: LIB_LIMIT_PART_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-limit-parse", from: BFF_PARSE_FROM, to: BFF_PARSE_TO },
      { name: "bff-limit-call", from: BFF_CALL_FROM, to: BFF_CALL_TO },
    ],
  },
  {
    file: SIDEBAR_PATH,
    swaps: [
      { name: "sidebar-fetch", from: SIDEBAR_FETCH_FROM, to: SIDEBAR_FETCH_TO },
      { name: "sidebar-payload", from: SIDEBAR_PAYLOAD_FROM, to: SIDEBAR_PAYLOAD_TO },
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

  const backup = target.file + ".pre_badge.bak";
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