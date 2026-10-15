// add_needs_reply.mjs — Phase 22: Needs Reply (customer waiting detector).
//
// Zero AI, zero schema changes, no bridge changes -> NO bot restart. Closes
// the inbox-hygiene loop (after unassigned + auto-close): a conversation
// "needs reply" when the customer sent the LAST message and no outbound
// (human or AI) has gone after it. Deterministic SQL — last-in id vs last-out
// id per conversation.
//
//   - CP: GET /portal/conversations gains a per-row needs_reply EXISTS column
//     plus an optional needs_reply=1 filter. GET /portal/overview gains a
//     needs_reply_open counter (open chats needing a reply).
//   - Website: portal.ts ConversationSummary.needsReply + listConversations
//     needsReplyOnly param + OverviewData.needsReplyOpen; BFF conversations
//     route forwards needs_reply; inbox gets a "Needs reply" chip + an
//     "awaiting reply" badge on matching rows; Overview gets a 5th stat tile.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_needs_reply.mjs
//
// Requires Phase 21 (add_autoclose_idle.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_nreply.bak
// Expected first run: 20 applied, 0 warnings (20 swaps, no new files).
// Expected rerun:     0 applied, 20 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const CP_GROWTH_PATH = "OmniFlow-Control-Plane/portal_growth.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const OVERVIEW_PAGE_PATH = "Omniflow/app/dashboard/(portal)/page.tsx";

// --------------------------------------------------------------------------
// Control Plane: portal_conversations.py (column + public map + filter)
// --------------------------------------------------------------------------

const CONV_COLUMN_FROM = `        " ) AS unread FROM "`;

const CONV_COLUMN_TO = `        " ) AS unread, EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " lr WHERE lr.conversation_id = c.id"
        " GROUP BY lr.conversation_id"
        " HAVING COALESCE(MAX(CASE WHEN lr.direction = 'in' THEN lr.id END), 0)"
        " > COALESCE(MAX(CASE WHEN lr.direction = 'out' THEN lr.id END), 0)"
        " ) AS needs_reply FROM "`;

const CONV_PUBLIC_FROM = `        "unread": bool(row.get("unread"))`;

const CONV_PUBLIC_TO = `        "unread": bool(row.get("unread")),
        "needs_reply": bool(row.get("needs_reply"))`;

const CONV_FILTER_FROM = `    tag_filter = (request.args.get("tag") or "").strip()[:MAX_TAG_LENGTH]
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)
    if search:`;

const CONV_FILTER_TO = `    tag_filter = (request.args.get("tag") or "").strip()[:MAX_TAG_LENGTH]
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)
    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0))"
        )
    if search:`;

const CONV_EXPORT_FILTER_FROM = `        params.append(channel_filter)
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)
    if search:`;

const CONV_EXPORT_FILTER_TO = `        params.append(channel_filter)
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)
    if (request.args.get("needs_reply") or "").strip() == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0))"
        )
    if search:`;

// --------------------------------------------------------------------------
// Control Plane: portal_growth.py (overview counter + response key)
// --------------------------------------------------------------------------

const GROWTH_QUERY_FROM = `                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND status = 'open'"
                    " AND assigned_to IS NULL) AS unassigned_open",
                    (client_id, client_id, client_id, client_id, client_id),`;

const GROWTH_QUERY_TO = `                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND status = 'open'"
                    " AND assigned_to IS NULL) AS unassigned_open,"
                    " (SELECT COUNT(*) FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " oc WHERE oc.client_id = %s AND oc.status = 'open'"
                    " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
                    " om WHERE om.conversation_id = oc.id"
                    " GROUP BY om.conversation_id"
                    " HAVING COALESCE(MAX(CASE WHEN om.direction = 'in' THEN om.id END), 0)"
                    " > COALESCE(MAX(CASE WHEN om.direction = 'out' THEN om.id END), 0))"
                    " ) AS needs_reply_open",
                    (client_id, client_id, client_id, client_id, client_id, client_id),`;

const GROWTH_RESPONSE_FROM = `            "unassigned_open": int(stats.get("unassigned_open") or 0),`;

const GROWTH_RESPONSE_TO = `            "unassigned_open": int(stats.get("unassigned_open") or 0),
            "needs_reply_open": int(stats.get("needs_reply_open") or 0),`;

// --------------------------------------------------------------------------
// Website: lib/omniflow/portal.ts
// --------------------------------------------------------------------------

const LIB_INTERFACE_FROM = `  createdAt: string | null;
  unread: boolean;
  lastIntent: string | null;`;

const LIB_INTERFACE_TO = `  createdAt: string | null;
  unread: boolean;
  needsReply: boolean;
  lastIntent: string | null;`;

const LIB_NORMALIZE_FROM = `    unread: p.unread === true,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,`;

const LIB_NORMALIZE_TO = `    unread: p.unread === true,
    needsReply: p.needs_reply === true,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,`;

const LIB_SIGNATURE_FROM = `  channelFilter?: string,
  tagFilter?: string
): Promise<ConversationSummary[] | null> {`;

const LIB_SIGNATURE_TO = `  channelFilter?: string,
  tagFilter?: string,
  needsReplyOnly?: boolean
): Promise<ConversationSummary[] | null> {`;

const LIB_PARTS_FROM = `  const parts = [searchPart, statusPart, intentPart, channelPart, tagPart].filter(
    Boolean
  );`;

const LIB_PARTS_TO = `  const replyPart = needsReplyOnly ? "needs_reply=1" : "";
  const parts = [searchPart, statusPart, intentPart, channelPart, tagPart, replyPart].filter(
    Boolean
  );`;

const LIB_OVERVIEW_IFACE_FROM = `  openNow: number;
  unassignedOpen: number;
  hotLeads: OverviewHotLead[];
}`;

const LIB_OVERVIEW_IFACE_TO = `  openNow: number;
  unassignedOpen: number;
  needsReplyOpen: number;
  hotLeads: OverviewHotLead[];
}`;

const LIB_OVERVIEW_MAP_FROM = `    unassignedOpen:
      typeof stats.unassigned_open === "number" ? stats.unassigned_open : 0,
    hotLeads,`;

const LIB_OVERVIEW_MAP_TO = `    unassignedOpen:
      typeof stats.unassigned_open === "number" ? stats.unassigned_open : 0,
    needsReplyOpen:
      typeof stats.needs_reply_open === "number" ? stats.needs_reply_open : 0,
    hotLeads,`;

// --------------------------------------------------------------------------
// Website: BFF conversations route (param forward)
// --------------------------------------------------------------------------

const BFF_FROM = `    const tagParam = url.searchParams.get("tag");
    const tagFilter = tagParam ? tagParam.trim().slice(0, 24) : undefined;
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter
    );`;

const BFF_TO = `    const tagParam = url.searchParams.get("tag");
    const tagFilter = tagParam ? tagParam.trim().slice(0, 24) : undefined;
    const needsReplyOnly = url.searchParams.get("needs_reply") === "1";
    const conversations = await listConversations(
      accessToken,
      searchQuery,
      statusFilter,
      intentFilter,
      channelFilter,
      tagFilter,
      needsReplyOnly
    );`;

// --------------------------------------------------------------------------
// Website: inbox page (state + param + chip + row badge)
// --------------------------------------------------------------------------

const PAGE_IFACE_FROM = `  lastMessagePreview: string | null;
  unread: boolean;
  lastIntent: string | null;`;

const PAGE_IFACE_TO = `  lastMessagePreview: string | null;
  unread: boolean;
  needsReply: boolean;
  lastIntent: string | null;`;

const PAGE_STATE_FROM = `  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "website">("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");`;

const PAGE_STATE_TO = `  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "website">("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const needsReplyRef = useRef(false);`;

const PAGE_REFRESH_FROM = `      if (tagRef.current !== "all") listParams.set("tag", tagRef.current);
      const listQs = listParams.toString();`;

const PAGE_REFRESH_TO = `      if (tagRef.current !== "all") listParams.set("tag", tagRef.current);
      if (needsReplyRef.current) listParams.set("needs_reply", "1");
      const listQs = listParams.toString();`;

const PAGE_CHIP_FROM = `            {value === "all" ? "All channels" : value}
          </button>
        ))}
      </div>

      {tagOptions.length > 0 && (`;

const PAGE_CHIP_TO = `            {value === "all" ? "All channels" : value}
          </button>
        ))}
        <button
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
        </button>
      </div>

      {tagOptions.length > 0 && (`;

const PAGE_BADGE_FROM = `                        {item.unread && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)]"
                            title="Unread messages"
                          />
                        )}`;

const PAGE_BADGE_TO = `                        {item.unread && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)]"
                            title="Unread messages"
                          />
                        )}
                        {item.needsReply && (
                          <span
                            className="shrink-0 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                            title="Customer sent the last message — waiting for a reply"
                          >
                            awaiting reply
                          </span>
                        )}`;

// --------------------------------------------------------------------------
// Website: overview page (5th stat tile)
// --------------------------------------------------------------------------

const OVERVIEW_GRID_FROM = `          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">`;

const OVERVIEW_GRID_TO = `          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">`;

const OVERVIEW_TILE_FROM = `            <StatTile
              label="Open now"
              value={overview.openNow}
              sub={
                overview.unassignedOpen > 0
                  ? overview.unassignedOpen + " unassigned"
                  : "all assigned"
              }
            />
          </div>`;

const OVERVIEW_TILE_TO = `            <StatTile
              label="Open now"
              value={overview.openNow}
              sub={
                overview.unassignedOpen > 0
                  ? overview.unassignedOpen + " unassigned"
                  : "all assigned"
              }
            />
            <StatTile
              label="Needs reply"
              value={overview.needsReplyOpen}
              sub="customer sent the last message"
            />
          </div>`;

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "conv-needs-reply-column", from: CONV_COLUMN_FROM, to: CONV_COLUMN_TO },
      { name: "conv-public-map", from: CONV_PUBLIC_FROM, to: CONV_PUBLIC_TO },
      { name: "conv-needs-reply-filter", from: CONV_FILTER_FROM, to: CONV_FILTER_TO },
      { name: "conv-export-needs-reply-filter", from: CONV_EXPORT_FILTER_FROM, to: CONV_EXPORT_FILTER_TO },
    ],
  },
  {
    file: CP_GROWTH_PATH,
    swaps: [
      { name: "growth-overview-counter", from: GROWTH_QUERY_FROM, to: GROWTH_QUERY_TO },
      { name: "growth-overview-response", from: GROWTH_RESPONSE_FROM, to: GROWTH_RESPONSE_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-summary-interface", from: LIB_INTERFACE_FROM, to: LIB_INTERFACE_TO },
      { name: "lib-normalize", from: LIB_NORMALIZE_FROM, to: LIB_NORMALIZE_TO },
      { name: "lib-list-signature", from: LIB_SIGNATURE_FROM, to: LIB_SIGNATURE_TO },
      { name: "lib-list-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO },
      { name: "lib-overview-interface", from: LIB_OVERVIEW_IFACE_FROM, to: LIB_OVERVIEW_IFACE_TO },
      { name: "lib-overview-mapping", from: LIB_OVERVIEW_MAP_FROM, to: LIB_OVERVIEW_MAP_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-needs-reply-param", from: BFF_FROM, to: BFF_TO },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-interface", from: PAGE_IFACE_FROM, to: PAGE_IFACE_TO },
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-refresh-param", from: PAGE_REFRESH_FROM, to: PAGE_REFRESH_TO },
      { name: "inbox-chip", from: PAGE_CHIP_FROM, to: PAGE_CHIP_TO },
      { name: "inbox-row-badge", from: PAGE_BADGE_FROM, to: PAGE_BADGE_TO },
    ],
  },
  {
    file: OVERVIEW_PAGE_PATH,
    swaps: [
      { name: "overview-grid-cols", from: OVERVIEW_GRID_FROM, to: OVERVIEW_GRID_TO },
      { name: "overview-tile", from: OVERVIEW_TILE_FROM, to: OVERVIEW_TILE_TO },
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

  const backup = target.file + ".pre_nreply.bak";
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