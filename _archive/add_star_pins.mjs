// add_star_pins.mjs - Phase 39: star and pin conversations.
//
// Lazy migration adds a starred boolean to portal_conversations. The new
// POST /portal/conversations/<id>/star toggles it, the list and export accept
// starred=1 and always sort starred conversations first, and the inbox gets a
// star button on every row plus an amber Starred chip. Requires Phase 38
// applied first. Adds one BFF route file, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const BFF_CONV_PATH = "Omniflow/app/api/omniflow/portal/conversations/route.ts";
const INBOX_PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/page.tsx";
const BFF_STAR_PATH = "Omniflow/app/api/omniflow/portal/conversations/[id]/star/route.ts";

const NEW_FILES = [
  {
    path: BFF_STAR_PATH,
    content: `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  toggleConversationStar,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  try {
    const result = await toggleConversationStar(accessToken, conversationId);
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
      { error: { code: "not_found", message: "Conversation not found." } },
      404
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`,
  },
];

// portal_conversations.py

const CP_HELPER_FROM = `try:
    OVERDUE_HOURS = max(1, min(72, int(os.environ.get("OF_SLA_HOURS", "4"))))
except ValueError:
    OVERDUE_HOURS = 4`;

const CP_HELPER_TO = `try:
    OVERDUE_HOURS = max(1, min(72, int(os.environ.get("OF_SLA_HOURS", "4"))))
except (TypeError, ValueError):
    OVERDUE_HOURS = 4

_STAR_COLUMN_READY = False


def _ensure_star_column(conn) -> None:
    """Lazy migration: older databases miss the starred flag (runs once)."""
    global _STAR_COLUMN_READY
    if _STAR_COLUMN_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_db.CONV_TABLE) +
            " ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE"
        )
    conn.commit()
    _STAR_COLUMN_READY = True`;

const CP_ENSURE_LIST_FROM = `    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                tags_map = _tags_map(cur, principal["client_id"],
                                     [row.get("id") for row in found])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversations read")[0]), 503`;

const CP_ENSURE_LIST_TO = `    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                tags_map = _tags_map(cur, principal["client_id"],
                                     [row.get("id") for row in found])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversations read")[0]), 503`;

const CP_ENSURE_EXPORT_FROM = `    params.append(EXPORT_LIMIT)

    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:`;

const CP_ENSURE_EXPORT_TO = `    params.append(EXPORT_LIMIT)

    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:`;

const CP_ENSURE_DETAIL_FROM = `        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, channel, contact_id, contact_name, status,"`;

const CP_ENSURE_DETAIL_TO = `        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, channel, contact_id, contact_name, status,"`;

const CP_SELECT_LIST_FROM = `        " c.lead_score, c.lead_temp, c.assigned_to, tm.name AS assignee_name,"
        " EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " m WHERE m.conversation_id = c.id AND m.direction = 'in'"`;

const CP_SELECT_LIST_TO = `        " c.lead_score, c.lead_temp, c.assigned_to, c.starred, tm.name AS assignee_name,"
        " EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " m WHERE m.conversation_id = c.id AND m.direction = 'in'"`;

const CP_SELECT_EXPORT_FROM = `        " c.lead_score, c.lead_temp, c.assigned_to, tm.name AS assignee_name"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"`;

const CP_SELECT_EXPORT_TO = `        " c.lead_score, c.lead_temp, c.assigned_to, c.starred, tm.name AS assignee_name"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"`;

const CP_SELECT_DETAIL_FROM = `                    " c.lead_score, c.lead_temp, c.assigned_to,"
                    " tm.name AS assignee_name FROM "`;

const CP_SELECT_DETAIL_TO = `                    " c.lead_score, c.lead_temp, c.assigned_to, c.starred,"
                    " tm.name AS assignee_name FROM "`;

const CP_PUBLIC_FROM = `        "assigned_to": row.get("assigned_to"),
        "assignee_name": row.get("assignee_name"),
    }`;

const CP_PUBLIC_TO = `        "assigned_to": row.get("assigned_to"),
        "assignee_name": row.get("assignee_name"),
        "starred": bool(row.get("starred")),
    }`;

const CP_ORDER_LIST_FROM = `    if sort_order == "oldest":
        sql += " ORDER BY c.last_message_at ASC NULLS LAST, c.id ASC LIMIT %s"
    else:
        sql += " ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(limit)`;

const CP_ORDER_LIST_TO = `    if sort_order == "oldest":
        sql += " ORDER BY c.starred DESC, c.last_message_at ASC NULLS LAST, c.id ASC LIMIT %s"
    else:
        sql += " ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(limit)`;

const CP_ORDER_EXPORT_FROM = `    if sort_order == "oldest":
        sql += " ORDER BY c.last_message_at ASC NULLS LAST, c.id ASC LIMIT %s"
    else:
        sql += " ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(EXPORT_LIMIT)`;

const CP_ORDER_EXPORT_TO = `    if sort_order == "oldest":
        sql += " ORDER BY c.starred DESC, c.last_message_at ASC NULLS LAST, c.id ASC LIMIT %s"
    else:
        sql += " ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(EXPORT_LIMIT)`;

const CP_PARSE_LIST_FROM = `    include_counts = (request.args.get("include") or "").strip().lower() == "counts"

    sql = (`;

const CP_PARSE_LIST_TO = `    include_counts = (request.args.get("include") or "").strip().lower() == "counts"
    starred_filter = (request.args.get("starred") or "").strip()
    if starred_filter != "1":
        starred_filter = ""

    sql = (`;

const CP_PARSE_EXPORT_FROM = `    unread_filter = (request.args.get("unread") or "").strip()
    if unread_filter != "1":
        unread_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_PARSE_EXPORT_TO = `    unread_filter = (request.args.get("unread") or "").strip()
    if unread_filter != "1":
        unread_filter = ""
    starred_filter = (request.args.get("starred") or "").strip()
    if starred_filter != "1":
        starred_filter = ""
    intent_filter = (request.args.get("intent") or "").strip().lower()`;

const CP_WHERE_LIST_FROM = `    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_LIST_TO = `    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )
    if starred_filter == "1":
        sql += " AND c.starred = TRUE"

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):`;

const CP_WHERE_EXPORT_FROM = `    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

const CP_WHERE_EXPORT_TO = `    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )
    if starred_filter == "1":
        sql += " AND c.starred = TRUE"

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter`;

const CP_ENDPOINT_FROM = `@bp.post("/conversations/bulk")`;

const CP_ENDPOINT_TO = `@bp.post("/conversations/<int:conversation_id>/star")
def toggle_conversation_star(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET starred = NOT COALESCE(starred, FALSE)"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING starred",
                    (conversation_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if updated:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "conversation.star_toggled",
                        "customer_user",
                        principal.get("user_id"),
                        conversation_id,
                        "Star " + ("on" if updated[0].get("starred") else "off") + ".",
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation star")[0]), 503
    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Conversation not found."}}), 404
    return jsonify({"ok": True, "starred": bool(updated[0].get("starred"))}), 200


@bp.post("/conversations/bulk")`;

// lib/omniflow/portal.ts

const LIB_IFACE_FROM = `  assignedTo: string | null;
  assigneeName: string | null;
  tags: string[];
}`;

const LIB_IFACE_TO = `  assignedTo: string | null;
  assigneeName: string | null;
  starred: boolean;
  tags: string[];
}`;

const LIB_NORMALIZE_FROM = `    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
    tags: Array.isArray(p.tags)`;

const LIB_NORMALIZE_TO = `    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
    starred: p.starred === true,
    tags: Array.isArray(p.tags)`;

const LIB_SIGNATURE_FROM = `  daysFilter?: string,
  unreadFilter?: string
): Promise<`;

const LIB_SIGNATURE_TO = `  daysFilter?: string,
  unreadFilter?: string,
  starredFilter?: string
): Promise<`;

const LIB_STARRED_PART_FROM = `  const unreadPart = unreadFilter === "1" ? "unread=1" : "";`;

const LIB_STARRED_PART_TO = `  const unreadPart = unreadFilter === "1" ? "unread=1" : "";
  const starredPart = starredFilter === "1" ? "starred=1" : "";`;

const LIB_PARTS_FROM = `    daysPart,
    unreadPart,
  ].filter(Boolean);`;

const LIB_PARTS_TO = `    daysPart,
    unreadPart,
    starredPart,
  ].filter(Boolean);`;

const LIB_STAR_FN_FROM = `export type ConversationDetailResult =`;

const LIB_STAR_FN_TO = `export async function toggleConversationStar(
  accessToken: string,
  conversationId: number
): Promise<{ starred: boolean } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/star",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { starred: false };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return { starred: (payload as Record<string, unknown>).starred === true };
}

export type ConversationDetailResult =`;

// BFF conversations route

const BFF_PARSE_FROM = `    const unreadFilter = url.searchParams.get("unread") === "1" ? "1" : "";`;

const BFF_PARSE_TO = `    const unreadFilter = url.searchParams.get("unread") === "1" ? "1" : "";
    const starredFilter = url.searchParams.get("starred") === "1" ? "1" : "";`;

const BFF_CALL_FROM = `      daysFilter,
      unreadFilter
    );`;

const BFF_CALL_TO = `      daysFilter,
      unreadFilter,
      starredFilter
    );`;

// inbox page

const PAGE_IFACE_FROM = `  assignedTo: string | null;
  assigneeName: string | null;
  tags: string[];
}`;

const PAGE_IFACE_TO = `  assignedTo: string | null;
  assigneeName: string | null;
  starred: boolean;
  tags: string[];
}`;

const PAGE_STATE_FROM = `  const [unreadFilter, setUnreadFilter] = useState("");
  const unreadRef = useRef("");`;

const PAGE_STATE_TO = `  const [unreadFilter, setUnreadFilter] = useState("");
  const unreadRef = useRef("");
  const [starredFilter, setStarredFilter] = useState("");
  const starredRef = useRef("");`;

const PAGE_REFRESH_FROM = `      if (unreadRef.current) listParams.set("unread", unreadRef.current);`;

const PAGE_REFRESH_TO = `      if (unreadRef.current) listParams.set("unread", unreadRef.current);
      if (starredRef.current) listParams.set("starred", starredRef.current);`;

const PAGE_EXPORT_FROM = `      if (unreadRef.current) params.set("unread", unreadRef.current);`;

const PAGE_EXPORT_TO = `      if (unreadRef.current) params.set("unread", unreadRef.current);
      if (starredRef.current) params.set("starred", starredRef.current);`;

const PAGE_SEED_FROM = `    if (urlFilters.get("unread") === "1") {
      unreadRef.current = "1";
      setUnreadFilter("1");
    }
    void refresh();`;

const PAGE_SEED_TO = `    if (urlFilters.get("unread") === "1") {
      unreadRef.current = "1";
      setUnreadFilter("1");
    }
    if (urlFilters.get("starred") === "1") {
      starredRef.current = "1";
      setStarredFilter("1");
    }
    void refresh();`;

const PAGE_HELPERS_FROM = `  async function exportCsv() {`;

const PAGE_HELPERS_TO = `  async function toggleStar(conversationId: number) {
    setItems((current) =>
      current
        ? current.map((item) =>
            item.id === conversationId ? { ...item, starred: !item.starred } : item
          )
        : current
    );
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + conversationId + "/star",
        { method: "POST", credentials: "same-origin" }
      );
      if (!response.ok) void refresh();
    } catch {
      void refresh();
    }
  }

  async function exportCsv() {`;

const PAGE_CHIP_FROM = `          Unread
        </button>
      </div>`;

const PAGE_CHIP_TO = `          Unread
        </button>
        <button
          type="button"
          onClick={() => {
            const next = starredFilter === "1" ? "" : "1";
            starredRef.current = next;
            setStarredFilter(next);
            void refresh();
          }}
          className={\`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors \${
            starredFilter === "1"
              ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }\`}
        >
          Starred
        </button>
      </div>`;

const PAGE_ROW_FROM = `                  <div className="shrink-0 text-right">`;

const PAGE_ROW_TO = `                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      aria-label="Toggle star"
                      onClick={() => void toggleStar(item.id)}
                      className={\`text-base leading-none transition-transform hover:scale-110 \${
                        item.starred
                          ? "text-amber-300"
                          : "text-slate-600 hover:text-slate-400"
                      }\`}
                    >
                      {item.starred ? "\\u2605" : "\\u2606"}
                    </button>
                    <div className="text-right">`;

const PAGE_ROW_CLOSE_FROM = `                    <p className="mt-1 text-[10px] text-slate-600">
                      {formatTime(item.lastMessageAt)}
                    </p>
                  </div>
                </div>`;

const PAGE_ROW_CLOSE_TO = `                    <p className="mt-1 text-[10px] text-slate-600">
                      {formatTime(item.lastMessageAt)}
                    </p>
                    </div>
                  </div>
                </div>`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-helper", from: CP_HELPER_FROM, to: CP_HELPER_TO },
      { name: "cp-ensure-list", from: CP_ENSURE_LIST_FROM, to: CP_ENSURE_LIST_TO },
      { name: "cp-ensure-export", from: CP_ENSURE_EXPORT_FROM, to: CP_ENSURE_EXPORT_TO },
      { name: "cp-ensure-detail", from: CP_ENSURE_DETAIL_FROM, to: CP_ENSURE_DETAIL_TO },
      { name: "cp-select-list", from: CP_SELECT_LIST_FROM, to: CP_SELECT_LIST_TO },
      { name: "cp-select-export", from: CP_SELECT_EXPORT_FROM, to: CP_SELECT_EXPORT_TO },
      { name: "cp-select-detail", from: CP_SELECT_DETAIL_FROM, to: CP_SELECT_DETAIL_TO },
      { name: "cp-public", from: CP_PUBLIC_FROM, to: CP_PUBLIC_TO },
      { name: "cp-order-list", from: CP_ORDER_LIST_FROM, to: CP_ORDER_LIST_TO },
      { name: "cp-order-export", from: CP_ORDER_EXPORT_FROM, to: CP_ORDER_EXPORT_TO },
      { name: "cp-parse-list", from: CP_PARSE_LIST_FROM, to: CP_PARSE_LIST_TO },
      { name: "cp-parse-export", from: CP_PARSE_EXPORT_FROM, to: CP_PARSE_EXPORT_TO },
      { name: "cp-where-list", from: CP_WHERE_LIST_FROM, to: CP_WHERE_LIST_TO },
      { name: "cp-where-export", from: CP_WHERE_EXPORT_FROM, to: CP_WHERE_EXPORT_TO },
      { name: "cp-star-endpoint", from: CP_ENDPOINT_FROM, to: CP_ENDPOINT_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-iface", from: LIB_IFACE_FROM, to: LIB_IFACE_TO },
      { name: "lib-normalize", from: LIB_NORMALIZE_FROM, to: LIB_NORMALIZE_TO },
      { name: "lib-signature", from: LIB_SIGNATURE_FROM, to: LIB_SIGNATURE_TO, benign: true },
      { name: "lib-starred-part", from: LIB_STARRED_PART_FROM, to: LIB_STARRED_PART_TO },
      { name: "lib-parts", from: LIB_PARTS_FROM, to: LIB_PARTS_TO, benign: true },
      { name: "lib-star-fn", from: LIB_STAR_FN_FROM, to: LIB_STAR_FN_TO },
    ],
  },
  {
    file: BFF_CONV_PATH,
    swaps: [
      { name: "bff-starred-parse", from: BFF_PARSE_FROM, to: BFF_PARSE_TO },
      { name: "bff-starred-call", from: BFF_CALL_FROM, to: BFF_CALL_TO, benign: true },
    ],
  },
  {
    file: INBOX_PAGE_PATH,
    swaps: [
      { name: "inbox-iface", from: PAGE_IFACE_FROM, to: PAGE_IFACE_TO },
      { name: "inbox-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "inbox-refresh-param", from: PAGE_REFRESH_FROM, to: PAGE_REFRESH_TO },
      { name: "inbox-export-param", from: PAGE_EXPORT_FROM, to: PAGE_EXPORT_TO },
      { name: "inbox-url-seed", from: PAGE_SEED_FROM, to: PAGE_SEED_TO },
      { name: "inbox-toggle-star", from: PAGE_HELPERS_FROM, to: PAGE_HELPERS_TO },
      { name: "inbox-chip", from: PAGE_CHIP_FROM, to: PAGE_CHIP_TO },
      { name: "inbox-row-star", from: PAGE_ROW_FROM, to: PAGE_ROW_TO },
      { name: "inbox-row-star-close", from: PAGE_ROW_CLOSE_FROM, to: PAGE_ROW_CLOSE_TO },
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

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path)) {
    alreadyTotal++;
  } else {
    writeFileEnsuringDir(file.path, file.content);
    appliedTotal++;
    console.log("+ NEW " + file.path);
  }
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
    } else if (swap.benign) {
      console.log("  - " + target.file + " :: " + swap.name + " (superseded by a later phase - ok)");
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_star.bak";
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